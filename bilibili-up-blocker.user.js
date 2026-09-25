// ==UserScript==
// @name         Bilibili UP主黑名单屏蔽器
// @namespace    http://tampermonkey.net/
// @version      5.2.0
// @description  ①主页/视频页/热门页一键拉黑UP主，实时隐藏其视频卡片与直播推荐卡；②评论区展示IP属地；③视频页工具栏支持画面旋转与缩放。管理面板支持搜索/导入/导出备份/拖动。纯DOM识别UP主身份，仅在必要时调用API且全程限速。
// @author       victcity
// @match        *://*.bilibili.com/*
// @exclude      *://member.bilibili.com*
// @icon         https://www.bilibili.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/victcity/userscripts/main/bilibili-up-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/victcity/userscripts/main/bilibili-up-blocker.user.js
// @connect      api.bilibili.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

// 说明：评论区IP属地功能重构合并自 mscststs 的「B站评论区开盒」v1.02（ISC License）。
// 该模块必须在页面主世界运行（拦截脚本插入、劫持 bbComment 注册、补丁新版评论脚本），
// 因此通过函数序列化 + <script> 注入的方式在 document-start 执行；黑名单模块留在油猴
// 沙箱世界使用 GM_* API，两者互不干扰。

(function () {
    'use strict';

    // ==================== 评论IP属地模块（注入页面主世界） ====================
    // 以下函数整体序列化后注入页面执行，必须自包含，不得引用外部作用域变量。
    function commentLocationPageBootstrap() {
        function getLocationSpanByReply(reply, attrs) {
            attrs = attrs || "";
            if (reply && reply.reply_control && reply.reply_control.location) {
                return `<span class="reply-location" ${attrs}>${reply.reply_control.location || ''}</span>`;
            } else {
                return "";
            }
        }

        // 仅保留页面注入代码实际用到的工具（原脚本 870 行 utils 的最小子集）
        var utils = {
            unhtml: function (str) {
                return str ? str.replace(/[&<">'](?:(amp|lt|quot|gt|#39|nbsp|#\d+);)?/g, function (a, b) {
                    if (b) return a;
                    return { '<': '&lt;', '&': '&amp;', '"': '&quot;', '>': '&gt;', "'": '&apos;' }[a];
                }) : '';
            },
            browser: { version: { mobile: /AppleWebKit.*Mobile.*/i.test(navigator.userAgent) } },
            trimHttp: function (url) { return url ? url.replace(/^http:/, '') : ''; },
            webp: function (url, args) {
                if (!url) return url;
                var suffix = url.match(/(.*\.(jpg|jpeg|gif|png|bmp))(\?.*)?/);
                if (!suffix || suffix[2] === 'bmp' || url.indexOf('/bfs/') === -1) return url;
                var filter = [];
                if (args && args.w && args.h) filter.push(args.w + 'w', args.h + 'h');
                if (args && args.freeze) filter.push('1s');
                if (!filter.length) return url;
                return suffix[1] + '@' + filter.join('_') + '.webp' + (suffix[3] || '');
            }
        };

        function waitSelector(selector, timeout) {
            timeout = timeout || 30000;
            return new Promise(function (resolve) {
                var el = document.querySelector(selector);
                if (el) return resolve(el);
                var done = false;
                var observer = new MutationObserver(function () {
                    if (done) return;
                    var n = document.querySelector(selector);
                    if (n) { done = true; observer.disconnect(); clearTimeout(timer); resolve(n); }
                });
                observer.observe(document.documentElement, { childList: true, subtree: true });
                var timer = setTimeout(function () {
                    if (!done) { done = true; observer.disconnect(); resolve(null); }
                }, timeout);
            });
        }

        function hackEle(ele, func, callback) {
            var ori = ele[func];
            ele[func] = function (...args) {
                return callback(ori.bind(this), ...args);
            };
        }

        // —— 新版视频页（.browser-pc）：观察评论时间节点，从 Vue 组件 props 中取属地 ——
        function StartObserveNewPage() {
            waitSelector(".browser-pc").then(function (el) {
                if (!el) return;
                var targetNode = document.querySelector("body");
                function setCode() {
                    var nodes = [
                        ...document.querySelectorAll(".browser-pc .reply-item .reply-time"),
                        ...document.querySelectorAll(".browser-pc .sub-reply-item .sub-reply-time")
                    ];
                    nodes.forEach(function (node) {
                        if (!node.__vueParentComponent) return;
                        if (node.settled) return;
                        node.settled = true;
                        var item = node.__vueParentComponent.props.reply || node.__vueParentComponent.props.subReply;
                        var locationSpan = getLocationSpanByReply(item, `style="margin-right:20px;"`);
                        node.outerHTML = node.outerHTML + locationSpan;
                    });
                }
                var observer = new MutationObserver(function () { setCode(); });
                observer.observe(targetNode, { childList: true, subtree: true });
                setCode();
            });
        }

        hackEle(HTMLBodyElement.prototype, "insertBefore", hack);
        hackEle(HTMLHeadElement.prototype, "insertBefore", hack);
        hackEle(HTMLBodyElement.prototype, "appendChild", hack);
        hackEle(HTMLHeadElement.prototype, "appendChild", hack);

        StartObserveNewPage();

        function injectbbComment() {
            var bbComment = window.bbComment;
            if (!bbComment || !bbComment.prototype) return;
            if (!bbComment.prototype._createSubReplyUserFace) {
                injectOldbbComment();
            } else {
                injectNewbbComment();
            }
        }

        // —— 旧版评论（bbComment/jQuery 版）：覆盖极少的旧页面 ——
        function injectOldbbComment() {
            var g = window.bbComment;
            var f = utils;
            g.prototype._createListCon = function (e, n, t) {
                var locationSpan = getLocationSpanByReply(e);
                var r = this._parentBlacklistDom(e, n, t)
                , i = ['<div class="con ' + (t == n ? "no-border" : "") + '">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate) + this._createUserSailing(e.member && e.member.user_sailing || {}) + "</div>", this._createMsgContent(e), '<div class="info">', e.floor ? '<span class="floor">#' + e.floor + "</span>" : "", this._createPlatformDom(e.content.plat), '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, e.lottery_id ? "" : '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", e.lottery_id ? "" : '<span class="hate ' + (2 == e.action ? "hated" : "") + '"><i></i></span>', e.lottery_id ? "" : this._createReplyBtn(e.rcount), e.lottery_id && e.mid !== this.userStatus.mid ? "" : '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", this._createLotteryContent(e.content), this._createVoteContent(e.content), this._createTags(e), "</div>", '<div class="reply-box">', this._createSubReplyList(e.replies, e.rcount, !1, e.rpid, e.folder && e.folder.has_folded), "</div>", '<div class="paging-box">', "</div>", "</div>"].join("");
                return f.browser.version.mobile && (i = ['<div class="con ' + (t == n ? "no-border" : "") + '">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate) + '<div class="right">', e.floor ? '<span class="floor">#' + e.floor + "</span>" : "", '<span class="time">' + this._formateMobileTime(e.ctime) + "</span></div>", "</div>", this._createMsgContent(e), this._createVoteContent(e.content), '<div class="info">', this._createPlatformDom(e.content.plat), '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="hate ' + (2 == e.action ? "hated" : "") + '"><i></i></span>', this._createReplyBtn(e.rcount), '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", this._createTags(e), '<div class="reply-box">', this._createSubReplyList(e.replies, e.rcount, !1, e.rpid, e.folder && e.folder.has_folded), "</div>", '<div class="paging-box">', "</div>", "</div>"].join("")),
                    e.state === this.blacklistCode ? r : i
            }
            g.prototype._createSubFoldedListCon = function (e) {
                var locationSpan = getLocationSpanByReply(e);
                var n = this._parentBlacklistDom(e, 0)
                , t = ['<div class="con">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate), "</div>", this._createMsgContent(e), '<div class="info">', '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", this._createReplyBtn(e.rcount), '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>"].join("");
                return f.browser.version.mobile && (t = ['<div class="con">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate), '<div class="right">', '<span class="time">' + this._formateMobileTime(e.ctime) + "</span></div>", "</div>", this._createMsgContent(e), '<div class="info">', this._createPlatformDom(e.content.plat), '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="reply btn-hover">回复</span>', '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>"].join("")),
                    e.state === this.blacklistCode ? n : t
            }
            g.prototype._createTopFoldedListCon = function (e) {
                var locationSpan = getLocationSpanByReply(e);
                var n = this._parentBlacklistDom(e, 0)
                , t = ['<div class="con">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate), "</div>", this._createMsgContent(e), '<div class="info">', e.floor ? '<span class="floor">#' + e.floor + "</span>" : "", this._createPlatformDom(e.content.plat), '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="hate ' + (2 == e.action ? "hated" : "") + '"><i></i></span>', this._createReplyBtn(e.rcount), '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>"].join("");
                return f.browser.version.mobile && (t = ['<div class="con">', '<div class="user">' + this._identity(e.mid, e.assist, e.member.fans_detail), '<a data-usercard-mid="' + e.mid + '" href="//space.bilibili.com/' + e.mid + '" target="_blank" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + '</a><a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>' + this._createNameplate(e.member.nameplate), '<div class="right">', e.floor ? '<span class="floor">#' + e.floor + "</span>" : "", '<span class="time">' + this._formateMobileTime(e.ctime) + "</span></div>", "</div>", this._createMsgContent(e), '<div class="info">', this._createPlatformDom(e.content.plat), '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="hate ' + (2 == e.action ? "hated" : "") + '"><i></i></span>', this._createReplyBtn(e.rcount), '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(e) ? '<li class="set-top">' + (e.isUpTop ? "取消置顶" : "设为置顶") + "</li>" : "") + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) && !e.isTop ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>"].join("")),
                    e.state === this.blacklistCode ? n : t
            }

            g.prototype._parentBlacklistDom = function (e, n, t) {
                var locationSpan = getLocationSpanByReply(e);
                return ['<div class="con ' + (t == n ? "no-border" : "") + '">', '<div class="user blacklist-font-color">黑名单用户</div>', '<p class="text">由于黑名单设置，该评论已被隐藏。</p>', '<div class="info">', e.floor ? '<span class="floor">#' + e.floor + "</span>" : "", this._createPlatformDom(e.content.plat), '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, this._canDel(e.mid) ? '<div class="operation btn-hover"><div class="spot"></div><div class="opera-list"><ul><li class="del" data-mid="' + e.mid + '">删除</li></ul></div></div>' : "", "</div>", "</div>"].join("")
            }
            g.prototype._subBlacklistDom = function (e) {
                var locationSpan = getLocationSpanByReply(e);
                return ['<div class="reply-item reply-wrap" data-id="' + e.rpid + '">', '<a class="reply-face"><img src="' + this.noface + '"></a>', '<div class="reply-con">', '<div class="user">', '<span class="blacklist-font-color name">黑名单用户 </span> <span class="text-con">由于黑名单设置，该回复已被隐藏。</span>', "</div>", "</div>", '<div class="info">', '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, this._canDel(e.mid) ? '<div class="operation btn-hover btn-hide-re"><div class="spot"></div><div class="opera-list"><ul><li class="del" data-mid="' + e.mid + '">删除</li></ul></div></div>' : "", "</div>", "</div>"].join("")
            }
            g.prototype._createSubReplyItem = function (e, n) {
                var locationSpan = getLocationSpanByReply(e);
                var t = ['<div class="reply-item reply-wrap" data-id="' + e.rpid + '" data-index="' + n + '">', '<a href="//space.bilibili.com/' + e.mid + '" data-usercard-mid="' + e.mid + '" target="_blank" class="reply-face">', '<img src="' + f.trimHttp(f.webp(e.member.avatar, {
                    w: 52,
                    h: 52
                })) + '" alt="">', "</a>", '<div class="reply-con">', '<div class="user">', '<a href="//space.bilibili.com/' + e.mid + '" target="_blank" data-usercard-mid="' + e.mid + '" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + "</a>", '<a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i></a>', this._createSubMsgContent(e), "</div>", "</div>", '<div class="info">', '<span class="time">' + this._formateTime(e.ctime) + "</span>", locationSpan, '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="hate ' + (2 == e.action ? "hated" : "") + '"><i></i></span>', '<span class="reply btn-hover">回复</span>', '<div class="operation btn-hover btn-hide-re"><div class="spot"></div><div class="opera-list"><ul>' + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>"].join("");
                return f.browser.version.mobile && (t = ['<div class="reply-item reply-wrap" data-id="' + e.rpid + '" data-index="' + n + '">', '<div class="reply-con">', '<div class="user">', '<a href="//space.bilibili.com/' + e.mid + '" target="_blank" data-usercard-mid="' + e.mid + '" class="name ' + this._createVipClass(e.member.vip.vipType, e.member.vip.vipStatus, e.member.vip.themeType) + '">' + f.unhtml(e.member.uname) + "</a>", '<a class="level-link" href="//www.bilibili.com/blackboard/help.html#%E4%BC%9A%E5%91%98%E7%AD%89%E7%BA%A7%E7%9B%B8%E5%85%B3" target="_blank"><i class="level l' + e.member.level_info.current_level + '"></i>', '<div class="right"><span class="time">' + this._formateMobileTime(e.ctime) + "</span></div>", "</a>", this._createSubMsgContent(e), "</div>", '<div class="info">', '<span class="like ' + (1 == e.action ? "liked" : "") + '"><i></i><span>' + (e.like || "") + "</span></span>", '<span class="reply btn-hover">回复</span>', '<div class="operation btn-hover btn-hide-re"><div class="spot"></div><div class="opera-list"><ul>' + (this._canBlackList(e.mid) ? '<li class="blacklist">加入黑名单</li>' : "") + (this._canReport(e.mid) ? '<li class="report">举报</li>' : "") + (this._canDel(e.mid) ? '<li class="del" data-mid="' + e.mid + '">删除</li>' : "") + "</ul></div></div>", "</div>", "</div>", "</div>"].join("")),
                    t
            }
        }

        // —— 较新版评论（bbComment 重构版） ——
        function injectNewbbComment() {
            var bbComment = window.bbComment;
            bbComment.prototype._createListCon = function (item, i, pos) {
                //黑名单结构
                var blCon = this._parentBlacklistDom(item, i, pos); //正常结构


                var con = ['<div class="con ' + (pos == i ? 'no-border' : '') + '">', '<div class="user">' + this._createNickNameDom(item), this._createLevelLink(item), this._identity(item.mid, item.assist, item.member.fans_detail), this._createNameplate(item.member.nameplate) + this._createUserSailing(item) + '</div>', this._createMsgContent(item), this._createPerfectReply(item), '<div class="info">', this._createPlatformDom(item.content.plat), "<span class=\"time-location\">", "<span class=\"reply-time\">".concat(this._formateTime(item.ctime), "</span>"), getLocationSpanByReply(item),
                           "</span>", item.lottery_id ? '' : '<span class="like ' + (item.action == 1 ? 'liked' : '') + '"><i></i><span>' + (item.like ? item.like : '') + '</span></span>', item.lottery_id ? '' : '<span class="hate ' + (item.action == 2 ? 'hated' : '') + '"><i></i></span>', item.lottery_id ? '' : this._createReplyBtn(item.rcount), item.lottery_id && item.mid !== this.userStatus.mid ? '' : '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(item) ? '<li class="set-top">' + (item.isUpTop ? '取消置顶' : '设为置顶') + '</li>' : '') + (this._canBlackList(item.mid) ? '<li class="blacklist">加入黑名单</li>' : '') + (this._canReport(item.mid) ? '<li class="report">举报</li>' : '') + (this._canDel(item.mid) && !item.isTop ? '<li class="del" data-mid="' + item.mid + '">删除</li>' : '') + '</ul></div></div>', this._createLotteryContent(item.content), this._createVoteContent(item.content), this._createTags(item), '</div>', '<div class="reply-box">', this._createSubReplyList(item.replies, item.rcount, false, item.rpid, item.folder && item.folder.has_folded, item.reply_control), '</div>', '<div class="paging-box">', '</div>', '</div>'].join('');

                if (utils.browser.version.mobile) {
                    con = ['<div class="con ' + (pos == i ? 'no-border' : '') + '">', '<div class="user">' + this._identity(item.mid, item.assist, item.member.fans_detail), this._createNickNameDom(item), this._createLevelLink(item), this._createNameplate(item.member.nameplate) + '<div class="right">', '<span class="time">' + this._formateMobileTime(item.ctime) + '</span></div>', '</div>', this._createMsgContent(item), this._createVoteContent(item.content), '<div class="info">', this._createPlatformDom(item.content.plat), '<span class="like ' + (item.action == 1 ? 'liked' : '') + '"><i></i><span>' + (item.like ? item.like : '') + '</span></span>', '<span class="hate ' + (item.action == 2 ? 'hated' : '') + '"><i></i></span>', this._createReplyBtn(item.rcount), '<div class="operation more-operation"><div class="spot"></div><div class="opera-list"><ul>' + (this._canSetTop(item) ? '<li class="set-top">' + (item.isUpTop ? '取消置顶' : '设为置顶') + '</li>' : '') + (this._canBlackList(item.mid) ? '<li class="blacklist">加入黑名单</li>' : '') + (this._canReport(item.mid) ? '<li class="report">举报</li>' : '') + (this._canDel(item.mid) && !item.isTop ? '<li class="del" data-mid="' + item.mid + '">删除</li>' : '') + '</ul></div></div>', '</div>', this._createTags(item), '<div class="reply-box">', this._createSubReplyList(item.replies, item.rcount, false, item.rpid, item.folder && item.folder.has_folded, item.reply_control), '</div>', '<div class="paging-box">', '</div>', '</div>'].join('');
                }

                return item.state === this.blacklistCode ? blCon : con;
            };
            bbComment.prototype._createSubReplyItem = function (item, i) {
                if (item.invisible) {
                    return '';
                }

                var dom = ['<div class="reply-item reply-wrap" data-id="' + item.rpid + '" data-index="' + i + '">', this._createSubReplyUserFace(item), '<div class="reply-con">', '<div class="user">', this._createNickNameDom(item), this._createLevelLink(item), this._identity(item.mid), this._createSubMsgContent(item), '</div>', '</div>', '<div class="info">', "<span class=\"time-location\">", "<span class=\"reply-time\">".concat(this._formateTime(item.ctime), "</span>"), getLocationSpanByReply(item),
                       "</span>", '<span class="like ' + (item.action == 1 ? 'liked' : '') + '"><i></i><span>' + (item.like ? item.like : '') + '</span></span>', '<span class="hate ' + (item.action == 2 ? 'hated' : '') + '"><i></i></span>', '<span class="reply btn-hover">回复</span>', '<div class="operation btn-hover btn-hide-re"><div class="spot"></div><div class="opera-list"><ul>' + (this._canBlackList(item.mid) ? '<li class="blacklist">加入黑名单</li>' : '') + (this._canReport(item.mid) ? '<li class="report">举报</li>' : '') + (this._canDel(item.mid) ? '<li class="del" data-mid="' + item.mid + '">删除</li>' : '') + '</ul></div></div>', '</div>', '</div>'].join('');

                if (utils.browser.version.mobile) {
                    dom = ['<div class="reply-item reply-wrap" data-id="' + item.rpid + '" data-index="' + i + '">', '<div class="reply-con">', '<div class="user">', this._createNickNameDom(item), this._createLevelLink(item), this._identity(item.mid), '<div class="right"><span class="time">' + this._formateMobileTime(item.ctime) + '</span></div>', '</a>', this._createSubMsgContent(item), '</div>', '<div class="info">', '<span class="like ' + (item.action == 1 ? 'liked' : '') + '"><i></i><span>' + (item.like ? item.like : '') + '</span></span>', '<span class="reply btn-hover">回复</span>', '<div class="operation btn-hover btn-hide-re"><div class="spot"></div><div class="opera-list"><ul>' + (this._canBlackList(item.mid) ? '<li class="blacklist">加入黑名单</li>' : '') + (this._canReport(item.mid) ? '<li class="report">举报</li>' : '') + (this._canDel(item.mid) ? '<li class="del" data-mid="' + item.mid + '">删除</li>' : '') + '</ul></div></div>', '</div>', '</div>', '</div>'].join('');
                }

                return dom;
            }
        }

        // 劫持 bbComment 全局注册：赋值瞬间完成原型补丁
        var bbCommentInstance = undefined;
        Object.defineProperty(window, 'bbComment', {
            get: function () {
                return bbCommentInstance;
            },
            set: function (val) {
                bbCommentInstance = val;
                injectbbComment();
            },
            configurable: true,
        });

        // 拦截脚本插入：评论数据脚本触发注入；新版评论脚本做源码补丁后接管执行
        function hack(origin, ...args) {
            const [ele, target] = [...args];
            if (ele.src && ~ele.src.indexOf("/x/v2/reply")) {
                // 确定是评论类型，执行额外流程
                injectbbComment()
            }

            // 监听 comment 组件的注入
            if (ele.src && ele.src.endsWith("comment.min.js")) {
                const ori = ele.onload;
                ele.onload = function (...args) {
                    injectbbComment();
                    ori && ori(...args);
                }
            };

            // 监听 comment_vue_next 组件的注入，直接在dynamic import 时修改源码，该版本针对Vue3架构
            if (ele.src && ele.src.endsWith("comment-pc-vue.next.js")) {
                !(async function () {
                    let code = await (await fetch(ele.src)).text();

                    const Ref1Index = code.indexOf("getReplyFloorInfo=");
                    const Ref2Index = code.indexOf("getReplyBoxStatus=");
                    if (Ref2Index > Ref1Index && Ref1Index > -1) {
                        code = code.replace(`getReplyFloorInfo=`, `_RAWgetReplyFloorInfo=`);
                        code = code.replace(`getReplyBoxStatus=`, `getReplyFloorInfo=Q=>{return {
                            ..._RAWgetReplyFloorInfo(Q),
                            replyLocation: computed(()=>{ return Q.value.reply_control.location || ""})
                          }
                        },getReplyBoxStatus=`);
                    } else {
                        console.error("【评论区开盒】Patch 失败【Vue3 版本】，无法找到正确的 Patch 位置");
                    }

                    eval(code);

                    ele.dispatchEvent(new Event("load", {
                        bubbles: true,
                    }));
                    ele.onload && ele.onload();

                })();

                return;
            };
            // 针对 lit 架构的
            if (ele.src && (ele.src.endsWith("comment-pc-elements.next.js") || (ele.src.indexOf("commentpc/bili-comments.") > -1))) {
                !(async function () {
                    let code = await (await fetch(ele.src)).text();

                    const Ref1Index = code.indexOf(`<div id="pubdate">','</div>`);

                    const Ref2Index = code.indexOf("this.pubDate,this.handleLike,");
                    if (Ref2Index > Ref1Index && Ref1Index > -1) {
                        //ref 1
                        code = code.replace(`<div id="pubdate">','</div>`, `<div id="pubdate">','</div><div id="location" style="margin-left:var(--kaihe-ml, 20px)">','</div>`);

                        //ref 2
                        code = code.replace(`this.pubDate,this.handleLike,`, `this.pubDate,(this.data && this.data.reply_control)? this.data.reply_control.location : null,this.handleLike,`);
                    } else {
                        console.error("【评论区开盒】Patch 失败【Elements-lit版本】，无法找到正确的 Patch 位置");
                    }

                    eval(code);

                    ele.dispatchEvent(new Event("load", {
                        bubbles: true,
                    }));
                    ele.onload && ele.onload();

                })();

                return;
            };

            let res = origin(...args);
            return res;
        }

        console.log('[B站屏蔽] 评论IP属地模块已就绪（页面世界）');
    }

    // 将评论模块注入页面主世界执行（沙箱世界改动 DOM 原型对页面代码无效）
    try {
        var bcrInjectScript = document.createElement('script');
        bcrInjectScript.textContent = '(' + commentLocationPageBootstrap.toString() + ')();';
        (document.head || document.documentElement).appendChild(bcrInjectScript);
        bcrInjectScript.remove();
    } catch (err) {
        console.log('[B站屏蔽] 评论IP属地模块注入失败:', err);
    }

    // ==================== 黑名单模块（油猴沙箱世界） ====================
    const VERSION = '5.2.0';
    const TAG = '[B站屏蔽]';
    const DEBUG = true;

    const KEY_BLACKLIST = 'bilibili_up_blacklist';   // 兼容 v3：UID 字符串数组
    const KEY_NAMES = 'bilibili_up_names';           // { uid: 昵称 }
    const KEY_BVID_MID = 'bilibili_bvid_mid_cache';  // { bvid: {mid, name} }

    const SCAN_DEBOUNCE_MS = 200;    // MutationObserver 触发扫描的去抖间隔
    const SWEEP_INTERVAL_MS = 3000;  // 兜底慢扫描（处理漏网/迟水合卡片）
    const FETCH_GAP_MS = 800;        // 相邻 API 请求最小间隔（限速防风控）
    const FETCH_FAIL_BACKOFF_MS = 10 * 60 * 1000; // 请求失败的 bvid 暂退避时长
    const CACHE_KEEP = 3000;         // bvid→mid 持久缓存条目上限

    const BV_RE = /\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})/i;
    const MID_RE = /space\.bilibili\.com\/(\d+)/;

    const log = (...args) => { if (DEBUG) console.log(TAG, ...args); };

    const blocked = new Set(GM_getValue(KEY_BLACKLIST, []));
    const names = GM_getValue(KEY_NAMES, {}) || {};
    const bvidMid = new Map(Object.entries(GM_getValue(KEY_BVID_MID, {}) || {}));

    // ==================== 样式（唯一一处定义） ====================
    function injectStyles() {
        GM_addStyle(`
        .bcr-host { position: relative !important; }
        .bcr-block-btn {
            all: unset !important;
            position: absolute !important;
            right: 0 !important;
            bottom: 0 !important;
            z-index: 30 !important;
            padding: 2px 8px !important;
            font-size: 12px !important;
            line-height: normal !important;
            color: #fff !important;
            background-color: #f45a5a !important;
            border-radius: 4px 0 4px 0 !important;
            cursor: pointer !important;
        }
        .bcr-block-btn:hover { background-color: #d63c3c !important; }
        .bcr-block-btn:disabled { opacity: .7; cursor: default !important; }
        /* 视频页等卡片不可插入真实节点(会破坏其 Vue 渲染导致顶栏挂载失败变空白)，按钮用伪元素渲染，点击走事件委托。
           注意：用 dataset 属性选择器而非自定义 class——视频页 Vue 重渲染会重写 className 抹掉外加类，dataset 属性不受影响 */
        .rec-list [data-bcr-state="ready"] { position: relative !important; }
        .rec-list [data-bcr-state="ready"]::after {
            content: '屏蔽';
            position: absolute;
            right: 0; bottom: 0;
            z-index: 30;
            padding: 2px 8px;
            font-size: 12px; line-height: normal;
            color: #fff; background-color: #f45a5a;
            border-radius: 4px 0 4px 0;
            cursor: pointer;
        }
        .rec-list [data-bcr-state="ready"]:hover::after { background-color: #d63c3c; }
        .rec-list [data-bcr-busy="1"]::after { content: '识别中…'; opacity: .7; cursor: wait; }
        .rec-list [data-bcr-blocked="1"]::after { content: '已拉黑'; opacity: .8; }
        /* 主页瀑布流栅格间距修正（隐藏卡片后保持行距均匀） */
        .recommended-container_floor-aside .container > *:nth-of-type(n + 6) {
            margin-top: unset !important;
        }
        #bcr-manager-panel {
            position: fixed; top: 120px; right: 20px; width: 320px;
            background-color: #ffffff; border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.15); z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 13px; line-height: 1.5; color: #18191c;
            display: none; flex-direction: column; overflow: hidden;
        }
        #bcr-manager-panel.bcr-show { display: flex; }
        .bcr-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px; background: linear-gradient(135deg, #fb7299, #fc8bab);
            color: #fff; cursor: move; user-select: none;
        }
        .bcr-title { font-size: 14px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 6px; }
        .bcr-count-badge { background: rgba(255,255,255,.25); border-radius: 10px; padding: 0 8px; font-size: 12px; font-weight: 500; }
        .bcr-close-btn { cursor: pointer; font-size: 18px; line-height: 1; opacity: .85; }
        .bcr-close-btn:hover { opacity: 1; }
        .bcr-body { padding: 12px 14px 14px; }
        .bcr-input-group { display: flex; gap: 8px; }
        #bcr-uid-input { flex: 1; min-width: 0; border: 1px solid #e3e5e7; border-radius: 6px; padding: 7px 10px; outline: none; font-size: 13px; }
        #bcr-uid-input:focus { border-color: #fb7299; }
        #bcr-add-btn { padding: 7px 14px; border: none; background-color: #fb7299; color: #fff; cursor: pointer; border-radius: 6px; font-size: 13px; white-space: nowrap; }
        #bcr-add-btn:hover { background-color: #f2658c; }
        .bcr-hint { font-size: 11px; color: #9499a0; margin: 6px 1px 10px; }
        .bcr-toolbar { display: flex; gap: 6px; margin-bottom: 10px; }
        #bcr-search-input { flex: 1; min-width: 0; border: 1px solid #e3e5e7; border-radius: 6px; padding: 5px 9px; font-size: 12px; outline: none; }
        #bcr-search-input:focus { border-color: #fb7299; }
        .bcr-mini-btn { border: 1px solid #e3e5e7; background-color: #fff; color: #61666d; border-radius: 6px; padding: 5px 9px; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .bcr-mini-btn:hover { border-color: #fb7299; color: #fb7299; }
        .bcr-mini-btn.bcr-danger { color: #f45a5a; border-color: #f7c9c9; }
        .bcr-mini-btn.bcr-danger:hover { background-color: #f45a5a; border-color: #f45a5a; color: #fff; }
        #bcr-import-area { margin-bottom: 10px; }
        #bcr-import-text { width: 100%; box-sizing: border-box; height: 72px; border: 1px solid #e3e5e7; border-radius: 6px; padding: 8px; font-size: 12px; resize: vertical; outline: none; }
        .bcr-import-actions { display: flex; gap: 6px; margin-top: 6px; }
        #bcr-uid-list { list-style: none; padding: 0; margin: 0; max-height: 300px; overflow-y: auto; border-top: 1px solid #f1f2f3; }
        #bcr-uid-list::-webkit-scrollbar { width: 6px; }
        #bcr-uid-list::-webkit-scrollbar-thumb { background: #e3e5e7; border-radius: 3px; }
        #bcr-uid-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid #f6f7f8; border-radius: 6px; }
        #bcr-uid-list li:last-child { border-bottom: none; }
        #bcr-uid-list li:hover { background: #f6f7f8; }
        #bcr-uid-list li.bcr-empty { display: block; text-align: center; color: #9499a0; font-size: 12px; padding: 22px 8px; border-bottom: none; }
        .bcr-item-main { min-width: 0; display: flex; flex-direction: column; }
        .bcr-item-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bcr-item-uid { font-size: 11px; color: #9499a0; }
        .bcr-remove-btn { cursor: pointer; color: #f45a5a; font-size: 12px; border: 1px solid #f7c9c9; background-color: #fff; padding: 3px 8px; border-radius: 6px; flex-shrink: 0; }
        .bcr-remove-btn:hover { background-color: #f45a5a; border-color: #f45a5a; color: white; }
        #bcr-toast-box {
            position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
            z-index: 100000; display: flex; flex-direction: column; align-items: center; gap: 8px;
            pointer-events: none;
        }
        .bcr-toast {
            background: rgba(24,25,28,.85); color: #fff; padding: 8px 16px; border-radius: 8px;
            font-size: 13px; max-width: 60vw; opacity: 0; transform: translateY(-8px);
            transition: opacity .25s, transform .25s;
        }
        .bcr-toast.bcr-toast-in { opacity: 1; transform: translateY(0); }
        .bcr-toast.bcr-toast-success { border-left: 3px solid #2ac864; }
        .bcr-toast.bcr-toast-error { border-left: 3px solid #f45a5a; }
        /* ===== 视频旋转与缩放工具条（适配深色模式变量） =====
           嵌套进工具栏容器走文档流（滚动天然跟手）：新版视频页注入 .video-toolbar-left，
           老版注入 .arc_toolbar_report。注意：新版页面的 Vue 应用在初始挂载/水合阶段
           对外来子节点极其敏感（会引发 bili-header.umd.js 双载、顶栏空白），
           因此必须等顶栏真实渲染完成并过稳定期后才嵌套。 */
        .bili-rotate-panel-wrap {
            flex: 1;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 12px;
            pointer-events: none;
            min-width: 200px;
        }
        .bili-rotate-panel {
            pointer-events: auto;
            display: flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            background: var(--bg2, #f4f4f4);
            border-radius: 6px;
            padding: 0 6px;
            border: 1px solid var(--line_regular, #e3e5e7);
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
            white-space: nowrap;
        }
        .bili-rotate-group { display: flex; align-items: center; gap: 2px; }
        .bili-rotate-btn {
            height: 24px;
            padding: 0 8px;
            border: none;
            background: transparent;
            color: var(--text1, #18191c);
            font-size: 12px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: sans-serif;
            font-weight: 500;
        }
        .bili-rotate-btn:hover { background: var(--graph_bg_regular, #e3e5e7); }
        .bili-rotate-btn.active {
            background: var(--brand_blue, #00a1d6);
            color: #fff !important;
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0, 161, 214, 0.3);
        }
        .bili-rotate-btn.active:hover { background: #00b5e5; }
        .bili-rotate-divider {
            width: 1px; height: 16px;
            background: var(--line_regular, #e3e5e7);
            margin: 0 2px;
        }
        .bili-rotate-scale {
            min-width: 42px;
            font-variant-numeric: tabular-nums;
            font-size: 12px;
            cursor: ns-resize; /* 提示用户可以上下滚动 */
        }
        /* 原地输入框样式 */
        .bili-rotate-input {
            width: 42px !important;
            text-align: center;
            padding: 0 !important;
            outline: none;
            border: 1px solid var(--brand_blue, #00a1d6) !important;
            background: var(--bg1, #fff);
            color: var(--text1, #18191c);
            box-shadow: 0 0 0 2px rgba(0, 161, 214, 0.2);
        }
        /* 隐藏 input 的默认上下箭头 */
        .bili-rotate-input::-webkit-outer-spin-button,
        .bili-rotate-input::-webkit-inner-spin-button {
            -webkit-appearance: none; margin: 0;
        }
        .bili-rotate-input { -moz-appearance: textfield; }
        .bili-rotate-reset { padding: 0 6px; }
        .bili-rotate-reset svg { width: 14px; height: 14px; }
    `);
    }

    // ==================== 黑名单存取 ====================
    function persistBlacklist() {
        GM_setValue(KEY_BLACKLIST, [...blocked]);
        GM_setValue(KEY_NAMES, names);
    }

    function persistBvidCache() {
        let obj = Object.fromEntries(bvidMid);
        const keys = Object.keys(obj);
        if (keys.length > CACHE_KEEP) {
            // Map 保持插入顺序，超限时丢弃最早的条目
            const drop = keys.length - CACHE_KEEP;
            for (let i = 0; i < drop; i++) bvidMid.delete(keys[i]);
            obj = Object.fromEntries(bvidMid);
        }
        GM_setValue(KEY_BVID_MID, obj);
    }

    const isBlocked = (uid) => blocked.has(String(uid));

    // 返回 'added' | 'exists' | 'invalid'
    function addBlocked(uid, name) {
        uid = String(uid).trim();
        if (!/^\d+$/.test(uid)) return 'invalid';
        if (name) names[uid] = String(name);
        if (blocked.has(uid)) {
            if (name && names[uid] !== String(name)) {
                names[uid] = String(name);
                persistBlacklist();
            }
            return 'exists';
        }
        blocked.add(uid);
        persistBlacklist();
        log(`已将 ${uid}${names[uid] ? '（' + names[uid] + '）' : ''} 加入黑名单`);
        applyAll();
        renderBlacklist();
        return 'added';
    }

    function removeBlocked(uid) {
        uid = String(uid);
        if (blocked.delete(uid)) {
            delete names[uid];
            persistBlacklist();
            log(`已将 ${uid} 移出黑名单，恢复其卡片显示`);
        }
        applyAll();
        renderBlacklist();
    }

    // ==================== API（仅热门页未知 bvid 与按钮点击兜底时使用，严格限速） ====================
    function fetchUpByBvid(bvid) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                timeout: 10000,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data && data.code === 0 && data.data && data.data.owner) {
                            resolve({ mid: String(data.data.owner.mid), name: data.data.owner.name });
                            return;
                        }
                        log(`API 查询 ${bvid} 未成功：code=${data && data.code}`);
                    } catch (e) { /* 忽略解析错误 */ }
                    resolve(null);
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    // 串行限速队列：请求失败不写缓存（避免"毒缓存"），仅内存退避
    const fetchQueue = [];
    const queued = new Set();
    const failedUntil = new Map();
    let lastFetchAt = 0;
    let draining = false;

    function queueFetch(bvid) {
        if (bvidMid.has(bvid) || queued.has(bvid)) return;
        const until = failedUntil.get(bvid);
        if (until && Date.now() < until) return;
        queued.add(bvid);
        fetchQueue.push(bvid);
        drainQueue();
    }

    function drainQueue() {
        if (draining) return;
        draining = true;
        const tick = () => {
            if (document.hidden) { setTimeout(tick, 5000); return; } // 页面不可见时暂停出队
            const bvid = fetchQueue.shift();
            if (!bvid) { draining = false; return; }
            const wait = Math.max(0, lastFetchAt + FETCH_GAP_MS - Date.now());
            setTimeout(() => {
                lastFetchAt = Date.now();
                fetchUpByBvid(bvid).then((info) => {
                    queued.delete(bvid);
                    if (info) {
                        bvidMid.set(bvid, info);
                        persistBvidCache();
                        applyMidToCards(bvid, info);
                    } else {
                        failedUntil.set(bvid, Date.now() + FETCH_FAIL_BACKOFF_MS);
                    }
                    tick();
                });
            }, wait);
        };
        tick();
    }

    // ==================== 页面适配器 ====================
    // 每个适配器负责：候选卡片选择器 / 从卡片提取信息 / 隐藏目标节点
    // 提取约定：返回 null 表示"暂不处理"（骨架屏等水合后再来）；返回 {hideOnly} 表示非视频卡片需隐藏
    const ADAPTERS = [
        {
            name: 'home',
            match: () => location.pathname === '/' && location.hostname === 'www.bilibili.com',
            cardSelector: '.bili-video-card, .floor-single-card',
            hideTarget(card) {
                // .bili-feed-card 嵌套在 .feed-card 内部，必须优先取外层 .feed-card（真正的栅格子元素）；
                // 若误藏内层，外层格子会被 grid 拉伸成一块永久空白
                return card.closest('.feed-card') || card.closest('.bili-feed-card') || card;
            },
            extract(card) {
                // 直播楼层卡（<span class="floor-title">直播</span>）直接隐藏；其他楼层卡（广告/活动等）不处理
                if (card.classList.contains('floor-single-card')) {
                    const title = card.querySelector('.floor-title');
                    if (title && title.textContent.trim() === '直播') {
                        return { hideOnly: true, target: card };
                    }
                    return null;
                }
                if (card.closest('.recommended-swipe')) return null;          // 顶部轮播不处理
                if (card.querySelector('.bili-video-card__skeleton')) return null; // 骨架屏，等水合
                const link = card.querySelector('a[href*="/video/BV"]');
                const bvid = link ? ((link.getAttribute('href') || '').match(BV_RE) || [])[1] : null;
                if (!bvid) return { hideOnly: true, target: this.hideTarget(card) }; // 广告等非视频卡片
                const owner = card.querySelector('a.bili-video-card__info--owner[href*="space.bilibili.com"]');
                const mid = owner ? ((owner.getAttribute('href') || '').match(MID_RE) || [])[1] : null;
                const nameSpan = owner && owner.querySelector('.bili-video-card__info--author');
                return { bvid, mid, name: nameSpan ? nameSpan.textContent.trim() : null };
            },
        },
        {
            name: 'video',
            match: () => location.hostname === 'www.bilibili.com' && location.pathname.startsWith('/video/'),
            cardSelector: '.rec-list .video-page-card-small, .rec-list .video-page-card-large',
            hideTarget(card) { return card; },
            extract(card) {
                const link = card.querySelector('a[href*="/video/BV"]');
                const bvid = link ? ((link.getAttribute('href') || '').match(BV_RE) || [])[1] : null;
                if (!bvid) return null;
                const upLink = card.querySelector('.upname a[href*="space.bilibili.com"]');
                const mid = upLink ? ((upLink.getAttribute('href') || '').match(MID_RE) || [])[1] : null;
                const nameSpan = upLink && upLink.querySelector('.name');
                return { bvid, mid, name: nameSpan ? nameSpan.textContent.trim() : (upLink ? upLink.textContent.trim() : null) };
            },
        },
        {
            name: 'popular',
            match: () => location.hostname === 'www.bilibili.com' && location.pathname.startsWith('/v/popular/'),
            cardSelector: '.flow-loader .card-list .video-card',
            hideTarget(card) { return card; },
            extract(card) {
                const link = card.querySelector('a[href*="/video/BV"]');
                const bvid = link ? ((link.getAttribute('href') || '').match(BV_RE) || [])[1] : null;
                if (!bvid) return null;
                const upSpan = card.querySelector('.up-name__text');
                // 热门页卡片无 UP 主链接：优先读 Biliscope 注入的属性，其次查缓存，最后排队走 API
                const mid = upSpan && upSpan.getAttribute('biliscope-userid')
                    ? upSpan.getAttribute('biliscope-userid')
                    : (bvidMid.has(bvid) ? bvidMid.get(bvid).mid : null);
                const cachedName = bvidMid.has(bvid) ? bvidMid.get(bvid).name : null;
                return {
                    bvid,
                    mid,
                    name: (upSpan && (upSpan.getAttribute('title') || upSpan.textContent.trim())) || cachedName,
                };
            },
        },
    ];

    let currentAdapter = null;
    // 这些页面的卡片由对子节点敏感的 Vue 应用管理，屏蔽按钮用 CSS 伪元素渲染而非真实节点
    const PSEUDO_BUTTON_ADAPTERS = new Set(['video']);

    // ==================== 卡片处理 ====================
    function makeButton(card, info) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bcr-block-btn';
        btn.textContent = '屏蔽';
        btn.title = '拉黑该UP主并隐藏其全部视频';
        btn.dataset.bvid = info.bvid;
        btn.dataset.mid = info.mid || '';
        btn.addEventListener('click', onBlockButtonClick);
        return btn;
    }

    function applyVisibility(card) {
        const mid = card.dataset.bcrMid;
        const target = currentAdapter.hideTarget(card) || card;
        if (mid && isBlocked(mid)) {
            target.style.display = 'none';
            card.dataset.bcrHidden = '1';
        } else if (card.dataset.bcrHidden === '1') {
            target.style.display = '';
            delete card.dataset.bcrHidden;
            delete card.dataset.bcrBlocked;
            // 取消屏蔽后复位按钮，使其可再次点击
            const btn = card.querySelector(':scope > .bcr-block-btn');
            if (btn && btn.disabled && btn.textContent === '已拉黑') {
                btn.disabled = false;
                btn.textContent = '屏蔽';
            }
        }
    }

    // 视频页伪元素按钮的点击处理（事件委托；伪元素点击的 target 是卡片根节点）
    function onVideoCardClick(e) {
        if (!currentAdapter || !PSEUDO_BUTTON_ADAPTERS.has(currentAdapter.name)) return;
        const card = e.target.closest('[data-bcr-state="ready"]');
        if (!card || card.dataset.bcrBusy === '1' || card.dataset.bcrBlocked === '1') return;
        const rect = card.getBoundingClientRect();
        if (e.clientX < rect.right - 46 || e.clientY < rect.bottom - 26) return; // 不在按钮区域
        e.preventDefault();
        e.stopPropagation();
        handlePseudoBlockClick(card);
    }

    async function handlePseudoBlockClick(card) {
        const bvid = card.dataset.bcrBvid;
        let mid = card.dataset.bcrMid || '';
        if (!mid && bvid) {
            card.dataset.bcrBusy = '1';
            const info = bvidMid.has(bvid) ? bvidMid.get(bvid) : await fetchUpByBvid(bvid);
            delete card.dataset.bcrBusy;
            if (!info) {
                toast('获取UP主信息失败，请稍后再试', 'error');
                return;
            }
            bvidMid.set(bvid, info);
            persistBvidCache();
            mid = info.mid;
            if (!card.dataset.bcrName) card.dataset.bcrName = info.name || '';
        }
        card.dataset.bcrBlocked = '1';
        addBlocked(mid, card.dataset.bcrName);
    }

    function applyMidToCards(bvid, info) {
        document.querySelectorAll(`[data-bcr-bvid="${bvid}"]`).forEach((card) => {
            card.dataset.bcrMid = info.mid;
            const btn = card.querySelector(':scope > .bcr-block-btn');
            if (btn) btn.dataset.mid = info.mid;
            if (card.dataset.bcrState === 'ready') applyVisibility(card);
        });
    }

    function processCard(card) {
        if (card.dataset.bcrState === 'ready') { applyVisibility(card); return; }
        if (card.dataset.bcrState === 'ad') return;

        const info = currentAdapter.extract(card);
        if (!info) return; // 骨架屏/轮播等，等下一轮

        if (info.hideOnly) {
            card.dataset.bcrState = 'ad';
            if (info.target) info.target.style.display = 'none';
            return;
        }

        card.dataset.bcrState = 'ready';
        card.dataset.bcrBvid = info.bvid;
        card.dataset.bcrMid = info.mid || '';
        card.dataset.bcrName = info.name || '';
        card.classList.add(PSEUDO_BUTTON_ADAPTERS.has(currentAdapter.name) ? 'bcr-pseudo-host' : 'bcr-host');
        if (!PSEUDO_BUTTON_ADAPTERS.has(currentAdapter.name) && !card.querySelector(':scope > .bcr-block-btn')) {
            card.appendChild(makeButton(card, info));
        }
        applyVisibility(card);
        if (!info.mid) queueFetch(info.bvid);
    }

    function scanPass() {
        if (currentAdapter) {
            document.querySelectorAll(currentAdapter.cardSelector).forEach(processCard);
        }
        rotateTick();
    }

    // 去抖：把 MutationObserver 的密集回调合并成低频扫描
    let scanTimer = 0;
    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = 0;
            scanPass();
        }, SCAN_DEBOUNCE_MS);
    }

    function applyAll() {
        if (!currentAdapter) return;
        document.querySelectorAll(`${currentAdapter.cardSelector}[data-bcr-state="ready"]`).forEach(applyVisibility);
    }

    // ==================== "屏蔽"按钮点击 ====================
    async function onBlockButtonClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        const card = btn.closest('[data-bcr-state="ready"]');
        if (!card) return;

        const bvid = btn.dataset.bvid || card.dataset.bcrBvid;
        let mid = card.dataset.bcrMid || btn.dataset.mid || '';

        if (!mid && bvid) {
            btn.disabled = true;
            btn.textContent = '识别中…';
            const info = bvidMid.has(bvid) ? bvidMid.get(bvid) : await fetchUpByBvid(bvid);
            btn.disabled = false;
            if (!info) {
                btn.textContent = '失败，稍后重试';
                setTimeout(() => { btn.textContent = '屏蔽'; }, 1500);
                return;
            }
            bvidMid.set(bvid, info);
            persistBvidCache();
            mid = info.mid;
            if (!card.dataset.bcrName) card.dataset.bcrName = info.name || '';
        }

        btn.disabled = true;
        btn.textContent = '已拉黑';
        addBlocked(mid, card.dataset.bcrName);
    }

    // ==================== 视频旋转与缩放模块 ====================
    // 重构自用户自用脚本 v3.2：去掉 1 秒永久轮询，改挂主扫描循环（去抖 MutationObserver + 3 秒兜底），
    // 对未变化的样式写入与 UI 刷新做跳过，避免持续触发样式重算。
    const ROTATE_PAGE_RE = /^\/(video|bangumi)\//;
    let currentAngle = 0;
    let userScale = 1.0;
    let lastRotateUrl = '';
    let lastRotateApplied = '';
    let lastRotateVideo = null;
    let lastRotateUI = '';

    function getBaseScale(video) {
        if (currentAngle === 90 || currentAngle === 270) {
            const container = document.querySelector('.bpx-player-video-area');
            if (container && video.videoWidth && video.videoHeight) {
                const cw = container.clientWidth, ch = container.clientHeight;
                const vw = video.videoWidth, vh = video.videoHeight;
                return Math.min(cw / vh, ch / vw);
            }
        }
        return 1;
    }

    function applyRotateTransform() {
        const video = document.querySelector('.bpx-player-video-wrap video');
        if (!video) { lastRotateApplied = ''; lastRotateVideo = null; return; }
        const baseScale = getBaseScale(video);
        const transform = (currentAngle === 0 && Math.abs(userScale - 1.0) < 0.001)
            ? 'none'
            : `rotate(${currentAngle}deg) scale(${baseScale * userScale})`;
        if (video !== lastRotateVideo || transform !== lastRotateApplied) {
            video.style.transformOrigin = 'center center';
            video.style.transform = transform;
            lastRotateApplied = transform;
            lastRotateVideo = video;
        }
    }

    function updateRotateUI() {
        const uiKey = `${currentAngle}|${Math.round(userScale * 100)}`;
        if (uiKey === lastRotateUI) return;
        const panel = document.querySelector('.bili-rotate-panel');
        if (!panel) return;
        lastRotateUI = uiKey;
        panel.querySelectorAll('[data-deg]').forEach((btn) => {
            btn.classList.toggle('active', parseInt(btn.dataset.deg) === currentAngle);
        });
        const scaleBtn = panel.querySelector('button.bili-rotate-scale');
        if (scaleBtn) scaleBtn.textContent = `${Math.round(userScale * 100)}%`;
    }

    // 核心交互：原地内联编辑
    function startInlineEdit(btn) {
        const currentVal = Math.round(userScale * 100);
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'bili-rotate-btn bili-rotate-scale bili-rotate-input';
        input.value = currentVal;
        input.min = 10; input.max = 500;

        btn.replaceWith(input);
        input.focus();
        input.select();

        const finishEdit = (save) => {
            let val = save ? parseFloat(input.value) : currentVal;
            if (isNaN(val)) val = 100;
            if (val < 10) val = 10;
            if (val > 500) val = 500;
            userScale = val / 100;

            const newBtn = document.createElement('button');
            newBtn.className = 'bili-rotate-btn bili-rotate-scale';
            newBtn.dataset.action = 'custom';
            newBtn.title = '点击编辑 / 滚轮微调 (按住Shift更精细)';
            input.replaceWith(newBtn);
            lastRotateUI = '';       // 强制下次刷新 UI
            applyRotateTransform();
            updateRotateUI();
        };

        const blurHandler = () => finishEdit(true);
        input.addEventListener('blur', blurHandler);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') {
                input.removeEventListener('blur', blurHandler);
                finishEdit(false);
            }
        });
    }

    // 工具栏宿主：新版视频页用 .video-toolbar-left，老版页面用 .arc_toolbar_report
    function rotateHost() {
        return document.querySelector('.video-toolbar-left, .arc_toolbar_report');
    }

    // 页面是否已挂载稳定：新版要求顶栏真实渲染出导航条(而非 SSR 占位)；老版无此结构则直接视为稳定
    function rotatePageSettled() {
        return !!document.querySelector('.bili-header .left-entry, .bili-header__bar, .arc_toolbar_report');
    }

    function injectRotatePanel() {
        const host = rotateHost();
        if (!host) return;

        const existingPanel = document.querySelector('.bili-rotate-panel-wrap');
        if (existingPanel && document.body.contains(existingPanel)) return;

        const panelWrap = document.createElement('div');
        panelWrap.className = 'bili-rotate-panel-wrap';
        panelWrap.innerHTML = `
            <div class="bili-rotate-panel">
                <div class="bili-rotate-group">
                    <button class="bili-rotate-btn active" data-deg="0">0°</button>
                    <button class="bili-rotate-btn" data-deg="90">90°</button>
                    <button class="bili-rotate-btn" data-deg="180">180°</button>
                    <button class="bili-rotate-btn" data-deg="270">270°</button>
                </div>
                <div class="bili-rotate-divider"></div>
                <div class="bili-rotate-group">
                    <button class="bili-rotate-btn" data-action="zoom-out" title="缩小 5%">-</button>
                    <button class="bili-rotate-btn bili-rotate-scale" data-action="custom" title="点击编辑 / 滚轮微调">100%</button>
                    <button class="bili-rotate-btn" data-action="zoom-in" title="放大 5%">+</button>
                </div>
                <div class="bili-rotate-divider"></div>
                <button class="bili-rotate-btn bili-rotate-reset" data-action="reset" title="重置所有">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="1 4 1 10 7 10"></polyline>
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                    </svg>
                </button>
            </div>
        `;
        // 嵌套进工具栏容器走文档流(flex 占位,滚动天然跟手);注入时机由 rotateTick 的稳定门禁保证
        host.appendChild(panelWrap);

        // 点击事件委托
        panelWrap.addEventListener('click', (e) => {
            const btn = e.target.closest('.bili-rotate-btn');
            if (!btn) return;
            const deg = btn.dataset.deg, action = btn.dataset.action;

            if (deg !== undefined) currentAngle = parseInt(deg);
            else if (action === 'zoom-in') userScale = Math.min(userScale + 0.05, 5);
            else if (action === 'zoom-out') { userScale -= 0.05; if (userScale < 0.1) userScale = 0.1; }
            else if (action === 'custom') { startInlineEdit(btn); return; }
            else if (action === 'reset') { currentAngle = 0; userScale = 1.0; }

            lastRotateUI = '';
            applyRotateTransform();
            updateRotateUI();
        });

        // 滚轮无极微调（按住 Shift 以 1% 精细微调，否则 5% 步进）
        panelWrap.addEventListener('wheel', (e) => {
            const scaleEl = e.target.closest('.bili-rotate-scale');
            if (scaleEl && scaleEl.tagName === 'BUTTON') {
                e.preventDefault(); // 阻止页面滚动
                const step = e.shiftKey ? 0.01 : 0.05;
                if (e.deltaY < 0) userScale = Math.min(userScale + step, 5);
                else { userScale -= step; if (userScale < 0.1) userScale = 0.1; }
                applyRotateTransform();
                updateRotateUI();
            }
        }, { passive: false });
    }

    // 主扫描循环每帧调用。嵌套前必须过"稳定门禁"：
    // 1) 顶栏真实渲染完成(新版)——其加载器在此之前对工具栏外来节点敏感，会引发 bili-header 双载；
    // 2) 再等 6 秒稳定期，避开页面挂载后的残余重渲染。
    let rotateSettleSince = 0;
    function rotateTick() {
        if (!ROTATE_PAGE_RE.test(location.pathname)) return;
        if (location.href !== lastRotateUrl) {
            lastRotateUrl = location.href;
            currentAngle = 0;
            userScale = 1.0;
            rotateSettleSince = 0;
        }
        if (!rotateSettleSince) {
            if (!rotateHost() || !rotatePageSettled()) return;
            rotateSettleSince = Date.now();
        }
        if (Date.now() - rotateSettleSince < 6000) return;
        injectRotatePanel();
        applyRotateTransform();
        updateRotateUI();
    }

    // ==================== 黑名单管理面板 ====================
    let blacklistPanel = null;

    // 输入容错：接受纯数字UID，或 space.bilibili.com/12345 形式的主页链接
    function extractUid(input) {
        const s = String(input || '').trim();
        if (/^\d+$/.test(s)) return s;
        const m = s.match(/space\.bilibili\.com\/(\d+)/);
        return m ? m[1] : null;
    }

    // 轻量操作反馈，替代 alert
    function toast(msg, type) {
        let box = document.getElementById('bcr-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'bcr-toast-box';
            document.body.appendChild(box);
        }
        const t = document.createElement('div');
        t.className = 'bcr-toast' + (type ? ' bcr-toast-' + type : '');
        t.textContent = msg;
        box.appendChild(t);
        requestAnimationFrame(() => t.classList.add('bcr-toast-in'));
        setTimeout(() => {
            t.classList.remove('bcr-toast-in');
            setTimeout(() => t.remove(), 300);
        }, 2200);
    }

    function createManagerPanel() {
        if (document.getElementById('bcr-manager-panel')) return;
        blacklistPanel = document.createElement('div');
        blacklistPanel.id = 'bcr-manager-panel';
        blacklistPanel.innerHTML = `
            <div class="bcr-header" title="按住可拖动">
                <h3 class="bcr-title">UP主黑名单 <span class="bcr-count-badge" id="bcr-count">0</span></h3>
                <span class="bcr-close-btn" title="关闭 (Esc)">×</span>
            </div>
            <div class="bcr-body">
                <div class="bcr-input-group">
                    <input type="text" id="bcr-uid-input" placeholder="输入UID或粘贴主页链接">
                    <button id="bcr-add-btn">拉黑</button>
                </div>
                <div class="bcr-hint">支持粘贴 space.bilibili.com 主页链接或纯数字UID，回车确认</div>
                <div class="bcr-toolbar">
                    <input type="text" id="bcr-search-input" placeholder="搜索昵称或UID">
                    <button class="bcr-mini-btn" id="bcr-export-btn" title="复制黑名单备份到剪贴板">导出</button>
                    <button class="bcr-mini-btn" id="bcr-import-btn" title="从备份内容导入">导入</button>
                    <button class="bcr-mini-btn bcr-danger" id="bcr-clear-btn" title="清空全部黑名单">清空</button>
                </div>
                <div id="bcr-import-area" style="display:none">
                    <textarea id="bcr-import-text" placeholder="粘贴导出的备份内容；也支持每行一个UID"></textarea>
                    <div class="bcr-import-actions">
                        <button class="bcr-mini-btn" id="bcr-import-ok">确认导入</button>
                        <button class="bcr-mini-btn" id="bcr-import-cancel">收起</button>
                    </div>
                </div>
                <ul id="bcr-uid-list"></ul>
            </div>
        `;
        document.body.appendChild(blacklistPanel);

        const uidInput = document.getElementById('bcr-uid-input');
        const doAdd = () => {
            const uid = extractUid(uidInput.value);
            if (!uid) {
                toast('请输入纯数字UID或 space.bilibili.com 链接', 'error');
                return;
            }
            const r = addBlocked(uid);
            if (r === 'added') toast(`已拉黑 ${names[uid] || uid}`, 'success');
            else if (r === 'exists') toast(`${names[uid] || uid} 已在黑名单中`);
            uidInput.value = '';
        };
        document.getElementById('bcr-add-btn').addEventListener('click', doAdd);
        uidInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doAdd(); });

        document.getElementById('bcr-search-input').addEventListener('input', renderBlacklist);
        document.getElementById('bcr-export-btn').addEventListener('click', exportBlacklist);
        document.getElementById('bcr-import-btn').addEventListener('click', () => {
            const area = document.getElementById('bcr-import-area');
            area.style.display = area.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('bcr-import-ok').addEventListener('click', importBlacklist);
        document.getElementById('bcr-import-cancel').addEventListener('click', () => {
            document.getElementById('bcr-import-area').style.display = 'none';
        });
        document.getElementById('bcr-clear-btn').addEventListener('click', clearBlacklist);

        document.getElementById('bcr-uid-list').addEventListener('click', (e) => {
            const target = e.target;
            if (target.classList.contains('bcr-remove-btn')) {
                const uid = target.dataset.uid;
                const nm = names[uid] || uid;
                removeBlocked(uid);
                toast(`已移除 ${nm}`);
            }
        });
        blacklistPanel.querySelector('.bcr-close-btn').addEventListener('click', toggleManagerPanel);
        bindPanelDrag();
        renderBlacklist();
    }

    function renderBlacklist() {
        const uidList = document.getElementById('bcr-uid-list');
        if (!uidList) return;
        const search = document.getElementById('bcr-search-input');
        const kw = (search ? search.value : '').trim().toLowerCase();
        const countBadge = document.getElementById('bcr-count');
        if (countBadge) countBadge.textContent = String(blocked.size);
        uidList.innerHTML = '';

        if (blocked.size === 0) {
            const li = document.createElement('li');
            li.className = 'bcr-empty';
            li.textContent = '黑名单为空，点击卡片上的"屏蔽"按钮或输入UID添加';
            uidList.appendChild(li);
            return;
        }
        const all = [...blocked];
        const shown = kw
            ? all.filter((u) => u.includes(kw) || (names[u] || '').toLowerCase().includes(kw))
            : all;
        if (shown.length === 0) {
            const li = document.createElement('li');
            li.className = 'bcr-empty';
            li.textContent = '没有匹配的结果';
            uidList.appendChild(li);
            return;
        }
        shown.forEach((uid) => {
            const li = document.createElement('li');
            const main = document.createElement('div');
            main.className = 'bcr-item-main';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'bcr-item-name';
            nameSpan.textContent = names[uid] || '（未记录昵称）';
            if (names[uid]) nameSpan.title = names[uid];
            const uidSpan = document.createElement('span');
            uidSpan.className = 'bcr-item-uid';
            uidSpan.textContent = `UID ${uid}`;
            main.appendChild(nameSpan);
            main.appendChild(uidSpan);
            const btn = document.createElement('button');
            btn.className = 'bcr-remove-btn';
            btn.dataset.uid = uid;
            btn.textContent = '移除';
            li.appendChild(main);
            li.appendChild(btn);
            uidList.appendChild(li);
        });
    }

    function exportBlacklist() {
        if (blocked.size === 0) { toast('黑名单为空，无需导出'); return; }
        const payload = JSON.stringify({ app: 'bilibili-up-blocker', version: 1, mids: [...blocked], names: { ...names } });
        const done = () => toast(`已导出 ${blocked.size} 条到剪贴板`, 'success');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload).then(done).catch(() => fallbackCopy(payload, done));
        } else {
            fallbackCopy(payload, done);
        }
    }

    function fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try {
            if (document.execCommand('copy')) done();
            else toast('导出失败，请手动复制', 'error');
        } catch (err) {
            toast('导出失败，请手动复制', 'error');
        }
        ta.remove();
    }

    function importBlacklist() {
        const textarea = document.getElementById('bcr-import-text');
        const raw = (textarea.value || '').trim();
        if (!raw) { toast('请先粘贴备份内容', 'error'); return; }
        const entries = [];
        try {
            const j = JSON.parse(raw);
            if (Array.isArray(j.mids)) {
                j.mids.forEach((u) => entries.push([String(u), j.names && j.names[u]]));
            } else if (Array.isArray(j)) {
                j.forEach((u) => entries.push([String(u)]));
            }
        } catch (err) { /* 非JSON，按行解析 */ }
        if (!entries.length) {
            raw.split(/\n+/).forEach((line) => {
                const m = line.match(/^\s*(\d{1,20})(?:[\s,，:：]+(.+))?$/);
                if (m) entries.push([m[1], m[2] && m[2].trim()]);
            });
        }
        if (!entries.length) { toast('未能识别任何UID', 'error'); return; }
        let added = 0, existed = 0, invalid = 0;
        for (const [uid, nm] of entries) {
            if (!/^\d+$/.test(uid)) { invalid++; continue; }
            if (blocked.has(uid)) {
                existed++;
                if (nm) names[uid] = nm;
                continue;
            }
            blocked.add(uid);
            if (nm) names[uid] = nm;
            added++;
        }
        persistBlacklist();
        applyAll();
        renderBlacklist();
        toast(`导入完成：新增 ${added}${existed ? '，已存在 ' + existed : ''}${invalid ? '，无效 ' + invalid : ''}`, added ? 'success' : undefined);
        textarea.value = '';
        document.getElementById('bcr-import-area').style.display = 'none';
    }

    function clearBlacklist() {
        if (blocked.size === 0) { toast('黑名单已经是空的'); return; }
        if (!confirm(`确定清空全部 ${blocked.size} 个UP主吗？`)) return;
        blocked.clear();
        Object.keys(names).forEach((k) => { delete names[k]; });
        persistBlacklist();
        applyAll();
        renderBlacklist();
        toast('黑名单已清空', 'success');
    }

    function bindPanelDrag() {
        const header = blacklistPanel.querySelector('.bcr-header');
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.bcr-close-btn')) return;
            e.preventDefault();
            const rect = blacklistPanel.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            blacklistPanel.style.right = 'auto';
            const onMove = (ev) => {
                const x = Math.min(Math.max(ev.clientX - dx, -(rect.width - 60)), window.innerWidth - 60);
                const y = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 40);
                blacklistPanel.style.left = `${x}px`;
                blacklistPanel.style.top = `${y}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function toggleManagerPanel() {
        if (!blacklistPanel) createManagerPanel();
        renderBlacklist();
        blacklistPanel.classList.toggle('bcr-show');
    }

    // ==================== 入口 ====================
    function main() {
        injectStyles();
        currentAdapter = ADAPTERS.find((a) => a.match()) || null;
        if (!currentAdapter) log(`未识别的页面 ${location.hostname}${location.pathname}，仅启用管理面板`);

        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(() => { if (!document.hidden) scanPass(); }, SWEEP_INTERVAL_MS); // 兜底

        // 视频旋转与缩放：窗口尺寸变化、新视频元数据加载完成时重新适配变换
        window.addEventListener('resize', applyRotateTransform);
        document.addEventListener('loadedmetadata', (e) => {
            if (e.target.tagName === 'VIDEO') applyRotateTransform();
        }, true);

        scanPass();

        GM_registerMenuCommand('打开/关闭黑名单管理器', toggleManagerPanel);

        // 视频页伪元素"屏蔽"按钮的点击委托
        document.addEventListener('click', onVideoCardClick);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && blacklistPanel && blacklistPanel.classList.contains('bcr-show')) {
                toggleManagerPanel();
            }
        });

        // 只读诊断句柄（在控制台可用：__bcr.stats() / __bcr.list() / __bcr.togglePanel()）
        try {
            unsafeWindow.__bcr = Object.freeze({
                version: VERSION,
                list: () => [...blocked],
                stats: () => ({
                    cards: currentAdapter ? document.querySelectorAll(currentAdapter.cardSelector).length : 0,
                    buttons: document.querySelectorAll('.bcr-block-btn').length,
                    hidden: document.querySelectorAll('[data-bcr-hidden]').length,
                    cached: bvidMid.size,
                    queue: fetchQueue.length,
                }),
                togglePanel: () => toggleManagerPanel(),
            });
        } catch (err) { /* 非沙箱环境忽略 */ }

        log(`v${VERSION} 已加载 | 页面: ${currentAdapter ? currentAdapter.name : 'unknown'} | 黑名单 ${blocked.size} 人`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();
