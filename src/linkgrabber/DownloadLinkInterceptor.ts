import * as Configs from "~/configs/Config";
import {getLatestConfig} from "~/configs/Config";
import {inRange} from "~/utils/NumberUtils";
import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import {addDownload, getHeadersForUrl} from "~/background/actions";
import {run} from "~/utils/ScopeFunctions";
import type {Tabs, WebRequest} from "webextension-polyfill";
import browser from "webextension-polyfill";
import {isChrome} from "~/utils/ExtensionInfo";
import urlMatch from "match-url-wildcard"
import {InterceptedMediaResult,} from "~/linkgrabber/LinkGrabberResponse";

import {OnMediaInterceptedFromRequestListener} from "~/media/OnMediaInterceptedFromRequestListener";
import {MEDIA_BLACKLIST_URLS} from "~/media/MediaBlackList";
import {getContentLength, getContentType} from "~/utils/HeaderUtils";
import {getFileExtension, getFileFromHeaders, getFileFromUrl} from "~/utils/URLUtils";
import {onMessage} from "webext-bridge/background";
import _ from "lodash";

type TabInfo = {
    title?: string,
    url?: string,
}

type InterceptedBrowserRequestWithResponse = {
    request: WebRequest.OnSendHeadersDetailsType,
    response?: WebRequest.OnHeadersReceivedDetailsType,
    handledOnWebRequest?: boolean,
}

export abstract class DownloadLinkInterceptor {
    protected readonly pendingRequests: Record<string, InterceptedBrowserRequestWithResponse> = {}
    private onMediaDetectedListener: OnMediaInterceptedFromRequestListener | null = null
    private tabCache: Record<number, TabInfo> = {}

    protected setPendingRequest(id: string, requestHeaders: WebRequest.OnSendHeadersDetailsType) {
        this.pendingRequests[id] = {
            request: requestHeaders,
        }
    }

    removePendingRequest(id: string) {
        setTimeout(() => {
            delete this.pendingRequests[id]
        }, 20_000)
    }

    protected readonly newTabs: Record<number, string> = {}

    protected addItemToNewTabs(tabId: number, link: string) {
        this.newTabs[tabId] = link
    }

    protected removeItemInNewTabs(tabId: number) {
        delete this.newTabs[tabId]
    }

    //utils

    protected isInConfigBlacklist(url: string) {
        const blackList = Configs.getLatestConfig().blacklistedUrls
        if (blackList.length == 0) {
            return false
        }
        return urlMatch(url, blackList)
    }

    protected isWebPageComponents(responseHeaders: Headers) {
        const contentType = getContentType(responseHeaders)
        if (contentType?.toLowerCase().startsWith("text/")) {
            return true
        }
        return false
    }

    protected isHLSRequest(
        url: string,
        requestHeaders: Headers,
        responseHeaders: Headers,
    ): InterceptedMediaResult | false {
        // we only receive requests that have m3u8 so it should be fine
        return {
            type: "media",
            mediaType: "hls",
            url: url,
            requestHeaders: requestHeaders,
            responseHeaders: responseHeaders,
        }
    }

    protected isDirectMedia(
        url: string,
        requestHeaders: Headers,
        responseHeaders: Headers,
    ): InterceptedMediaResult | false {
        const type = getContentType(responseHeaders)
        if (!type) {
            return false
        }
        for (const hlsType of ["video", "audio"]) {
            if (type.startsWith(hlsType)) {
                return {
                    type: "media",
                    mediaType: "http",
                    url: url,
                    requestHeaders: requestHeaders,
                    responseHeaders: responseHeaders,
                }
            }
        }
        return false
    }

    protected isInRegisteredFileFormats(fileExtension: string) {
        const extension = fileExtension.toLowerCase()
        if (!Configs.getLatestConfig().registeredFileTypes.includes(extension)) {
            return false
        }
        return true
    }

    private doWeAcceptThisFileSize(contentLength: number | null): boolean {
        if (contentLength === null) {
            // no Content-Length header, accept it
            return true
        }
        const minKb = Configs.getLatestConfig().captureFileSizeMinimumKb || 0
        if (minKb > 0) {
            // skip files smaller than the minimum size
            if (contentLength < minKb * 1024) {
                return false
            }
        }
        return true
    }

    protected shouldHandleRequestForDirectDownload(details: WebRequest.OnHeadersReceivedDetailsType): boolean {
        if (!(
            details.type === "main_frame"
            || details.type === "sub_frame"
        )) {
            // console.log("capture_error","frame type is not captured",details.type)
            return false
        }
        if (details.method !== "GET") {
            // console.log("capture_error","method not supported",details.method)
            // we only handle GET method
            return false
        }
        if (!Configs.getLatestConfig().autoCaptureLinks) {
            // console.log("capture_error","auto capture disabled")
            return false
        }
        if (!inRange(details.statusCode, 200, 299)) {
            // console.log("capture_error","not success",details.statusCode)
            return false
        }
        const responseHeaders = getHeaders(details.responseHeaders)
        if (this.isWebPageComponents(responseHeaders)) {
            // console.log("capture_error","is Web component")
            return false
        }
        if (this.isInConfigBlacklist(details.originUrl || details.url)) {
            return false
        }
        const downloadPage = this.getDownloadPage(details)
        if (downloadPage && this.isInConfigBlacklist(downloadPage)) {
            return false
        }
        // check file size minimum requirement
        const contentLength = getContentLength(responseHeaders)
        if (!this.doWeAcceptThisFileSize(contentLength)) {
            return false
        }

        if (this.isBypassShortcutPressed()) {
            return false
        }

        return this.isDirectDownloadContent(details, responseHeaders)
    }

    private isBypassShortcutPressed() {
        // When auto-capture of download links is enabled, holding down the shortcut key
        // and clicking on the download link uses the internal browser download method.
        return _keyName === getLatestConfig().bypassShortcut
    }

    private isDirectDownloadContent(
        details: WebRequest.OnHeadersReceivedDetailsType,
        responseHeaders: Headers,
    ): boolean {
        let fileName = getFileFromHeaders(responseHeaders)
        if (fileName === null) {
            fileName = getFileFromUrl(details.url)
        }
        if (fileName == null) {
            // console.log("capture_error","filename isNull")
            return false
        }
        const ext = getFileExtension(fileName)
        if (!this.isInRegisteredFileFormats(ext)) {
            // console.log("capture_error",`extension is not registered`,ext)
            return false
        }
        return true
    }


    protected async requestAddDownload(item: DownloadRequestItem) {
        const result = await addDownload([item])
        if (getLatestConfig().allowPassDownloadIfAppNotRespond) {
            return result
        }
        return true
    }

    protected createDirectDownloadItemFromWebRequest(
        request: WebRequest.OnSendHeadersDetailsType,
    ): DownloadRequestItem {
        let headers: Record<string, string> | null = null
        if (request?.requestHeaders) {
            headers = {}
            request.requestHeaders.forEach((header) => {
                if (header.value) {
                    headers![header.name] = header.value
                }
            })
        }
        const documentUrl = this.getDownloadPage(request)
        return {
            link: request.url,
            headers: headers,
            downloadPage: documentUrl,
            description: null,
            type: "http",
            suggestedName: null,
        }
    }

    private getDownloadPage(request: WebRequest.OnSendHeadersDetailsType): string | null {
        let documentUrl = request.documentUrl
        if (documentUrl) {
            return documentUrl
        }
        try {
            const tab = this.tabCache[request.tabId]
            return tab.url ?? null
        } catch (error) {
            return null
        }
    }

    protected isItNewTab(tabId: number) {
        const link = this.newTabs[tabId]
        return link !== undefined
    }


    protected async closeIfItWasNewTab(request: WebRequest.OnSendHeadersDetailsType) {
        if (!getLatestConfig().closeNewTabIfItWasCaptured) {
            return
        }
        const tabId = request.tabId
        if (this.isItNewTab(tabId)) {
            await browser.tabs.remove(tabId)
        }
    }

    // end of helper functions

    redirectDownloadsToExtension() {
        const filter: WebRequest.RequestFilter = {
            urls: ["*://*/*"],
        }
        receiveMessageFromContentScripts()
        browser.tabs.onCreated.addListener((tab) => {
            if (tab.id && tab.url) {
                this.addItemToNewTabs(tab.id, tab.url)
            }
            this.updateTabCache(tab)
        })
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.url) {
                this.removeItemInNewTabs(tabId)
            }
            this.updateTabCache(tab)
        })
        browser.tabs.onRemoved.addListener((tabId, _) => {
            this.removeItemInNewTabs(tabId)
            delete this.tabCache[tabId]
        })
        browser.webRequest.onSendHeaders.addListener(
            (details) => {
                this.setPendingRequest(details.requestId, details)
            },
            filter,
            run(() => {
                const extra: WebRequest.OnSendHeadersOptions[] = ["requestHeaders"]
                if (isChrome()) {
                    // chrome does not give us all headers unless we ask it
                    extra.push("extraHeaders")
                }
                return extra
            })
        )
        browser.webRequest.onErrorOccurred.addListener(
            (details) => {
                this.removePendingRequest(details.requestId)
            },
            filter,
        )
        browser.webRequest.onResponseStarted.addListener(
            (details) => {
                const request = this.pendingRequests[details.requestId]
                if (!request) {
                    return
                }
                this.checkForDirectMedia(details, request.request)
            },
            {
                types: ["media"],
                urls: ["*://*/*"],
            },
            [
                "responseHeaders"
            ],
        )
        browser.webRequest.onResponseStarted.addListener(
            (details) => {
                const request = this.pendingRequests[details.requestId]
                if (!request) {
                    return
                }
                this.checkForHLS(details, request.request)
            }, {
                types: ["xmlhttprequest"],
                urls: [
                    "http://*/*.m3u8",
                    "https://*/*.m3u8",
                    "http://*/*.m3u8?*",
                    "https://*/*.m3u8?*",
                ],
            },
            [
                "responseHeaders"
            ]
        )
        browser.webRequest.onCompleted.addListener(
            (details) => {
                this.removePendingRequest(details.requestId)
            },
            filter
        )
        browser.webRequest.onHeadersReceived.addListener(
            async (details) => {
                try {
                    const request = this.pendingRequests[details.requestId]
                    if (request === undefined) {
                        return this.passResponse()
                    }
                    request.response = details
                    const result = this.shouldHandleRequestForDirectDownload(details);
                    if (!result) {
                        return this.passResponse()
                    }
                    // let the browser.download now that we handled the request here!
                    request.handledOnWebRequest = true
                    // direct download
                    const downloadRequestItem = this.createDirectDownloadItemFromWebRequest(request.request)
                    const requestAccepted = await this.requestAddDownload(downloadRequestItem);
                    if (requestAccepted) {
                        // if (!this.canBlockResponse()) {
                        // in chrome, we must cancel download using downloads api
                        // so, we must let this response be available a little
                        // then removing it
                        // }
                        await this.onDownloadSendToAppSuccess(request.request)
                        // if (!isBrowserHonorRequestBlocking()){
                        //     delete cancelledBrowserDownloads[details.requestId]
                        // }
                        //cancel browser request
                        return this.cancelResponse()
                    } else {
                        await this.onDownloadSendToAppFailed(request.request)
                        // if (!isBrowserHonorRequestBlocking()){
                        //     startDownloadUsingNativeBrowser(request)
                        // }
                    }
                    return this.passResponse()
                } finally {
                    //
                }
            },
            filter,
            run(() => {
                const extra: WebRequest.OnHeadersReceivedOptions[] = ["responseHeaders"]
                if (this.canBlockResponse()) {
                    extra.push("blocking")
                }
                return extra
            })
        )
        browser.downloads?.onCreated?.addListener(async (details) => {
            if (!getLatestConfig().autoCaptureLinks) {
                console.log("autoCaptureLinks is disabled")
                return
            }
            // filter blob:, data: etc.
            if (!details.url.startsWith("http")) {
                console.log("download url not starts with http", details.url)
                return
            }
            // do we have recorded its request?
            const interceptedRequest = this
                .getInterceptedRequestByUrl(details.url)
            // we might already start download in webRequest so just cancell it here
            if (interceptedRequest?.handledOnWebRequest) {
                console.log("interceptedRequest already handled")
                await this.cancelDownload(details.id)
                return
            }
            if (interceptedRequest) {
                // we only support GET downloads, if we recorded the request then we can check if it
                if (interceptedRequest.request.method !== "GET") {
                    console.log("request method is not supported", interceptedRequest?.request.method)
                    return
                }
            }
            let downloadPage: string | null
            if (interceptedRequest) {
                downloadPage = this.getDownloadPage(interceptedRequest.request)
            } else {
                downloadPage = details.referrer || null
            }
            if (this.isInConfigBlacklist(details.url)) {
                return
            }
            if (downloadPage && this.isInConfigBlacklist(downloadPage)) {
                return
            }
            // check file size minimum requirement
            const contentLength = details.fileSize
            if (!this.doWeAcceptThisFileSize(contentLength)) {
                return
            }
            if (this.isBypassShortcutPressed()) {
                return
            }
            let requestHeaders: DownloadRequestHeaders = {}
            if (interceptedRequest) {
                interceptedRequest.request.requestHeaders?.forEach((header) => {
                    if (header.value) {
                        requestHeaders[header.name] = header.value
                    }
                })
            }
            if (_.isEmpty(requestHeaders)) {
                requestHeaders = await getHeadersForUrl(details.url) || {}
            }
            if (interceptedRequest?.response) {
                const response = interceptedRequest.response
                if (this.isInConfigBlacklist(response.originUrl || response.url)) {
                    return
                }
                const responseHeaders = getHeaders(response.responseHeaders)
                if (!this.isDirectDownloadContent(response, responseHeaders)) {
                    return
                }
            }

            await this.cancelDownload(details.id)
            const item: DownloadRequestItem = {
                link: details.url,
                description: null,
                downloadPage: downloadPage,
                headers: requestHeaders,
                suggestedName: null,
                type: "http",
            };
            await this.requestAddDownload(item)
        })
    }

    async cancelDownload(id: number) {
        try {
            await browser.downloads.cancel(id)
            await browser.downloads.erase({id: id})
            await browser.downloads.removeFile(id)
        } catch (error) {

        }
    }


    getInterceptedRequestByUrl(url: string) {
        return Object.values(this.pendingRequests).find(
            pr => {
                return pr.request.url === url
            }
        )
    }

    onMediaDetected(tabId: number, mediaResult: InterceptedMediaResult) {
        this.onMediaDetectedListener?.onMediaDetected(
            tabId, mediaResult,
        )
    }

    async onDownloadSendToAppSuccess(request: WebRequest.OnSendHeadersDetailsType) {
        await this.closeIfItWasNewTab(request)
    }

    async onDownloadSendToAppFailed(request: WebRequest.OnSendHeadersDetailsType) {
        // nothing
    }

    abstract passResponse(): any

    abstract cancelResponse(): any

    abstract canBlockResponse(): boolean

    setOnMediaDetectedListener(
        onMediaDetectedListener: OnMediaInterceptedFromRequestListener | null
    ) {
        this.onMediaDetectedListener = onMediaDetectedListener
    }

    private checkForHLS(details: WebRequest.OnResponseStartedDetailsType, request: WebRequest.OnSendHeadersDetailsType) {
        if (!this.shouldProcessMedia(details)) {
            return
        }
        const isHLS = this.isHLSRequest(
            details.url,
            getHeaders(request.requestHeaders),
            getHeaders(details.responseHeaders),
        );
        if (isHLS) {
            this.onMediaDetected(
                details.tabId,
                isHLS,
            )
        }
    }

    private shouldProcessMedia(details: WebRequest.OnResponseStartedDetailsType | WebRequest.OnCompletedDetailsType) {
        if (!Configs.getLatestConfig().popupEnabled) {
            return false
        }
        const resourceUrl = details.originUrl || details.url;
        if (this.isInConfigBlacklist(resourceUrl)) {
            return false
        }
        if (this.isInMediaBlackList(resourceUrl)) {
            return false
        }
        const downloadPage = this.getDownloadPage(details)
        if (downloadPage) {
            if (this.isInConfigBlacklist(downloadPage)) {
                return false
            }
            if (this.isInMediaBlackList(downloadPage)) {
                return false
            }
        }
        // check file size minimum requirement
        const contentLength = getContentLength(getHeaders(details.responseHeaders))
        if (!this.doWeAcceptThisFileSize(contentLength)) {
            return false
        }
        return true
    }

    private checkForDirectMedia(details: WebRequest.OnResponseStartedDetailsType, request: WebRequest.OnSendHeadersDetailsType) {
        if (!this.shouldProcessMedia(details)) {
            return
        }
        const isMedia = this.isDirectMedia(
            details.url,
            getHeaders(request.requestHeaders),
            getHeaders(details.responseHeaders),
        );
        if (isMedia) {
            this.onMediaDetected(
                details.tabId,
                isMedia,
            )
        }
    }

    private isInMediaBlackList(url: string) {
        const blackList = MEDIA_BLACKLIST_URLS
        if (blackList.length == 0) {
            return false
        }
        return urlMatch(url, blackList)
    }

    private updateTabCache(tab: Tabs.Tab) {
        if (!tab.id) return
        let tabInfo = this.tabCache[tab.id]
        if (!tabInfo) {
            tabInfo = {}
            this.tabCache[tab.id] = tabInfo
        }
        tabInfo.url = tab.url
        tabInfo.title = tab.title
    }
}

function getHeaders(responseHeaders?: browser.WebRequest.HttpHeaders): Headers {
    const headers = new Headers()
    responseHeaders?.forEach((header) => {
        if (header.value) {
            headers.set(header.name, header.value)
        }
    })
    return headers
}

let _keyName = ""

function receiveMessageFromContentScripts() {
    onMessage("get_event", async (msg) => {
        _keyName = msg.data
    })
}
