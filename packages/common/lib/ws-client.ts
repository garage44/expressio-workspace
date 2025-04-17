import {EventEmitter} from 'eventemitter3'
import {logger} from '@garage44/common/app'

type MessageData = Record<string, unknown>

interface WebSocketMessage {
    data?: MessageData
    id?: string
    method?: string
    url: string
}

export function constructMessage(url: string, data?: MessageData, id?: string, method?: string): WebSocketMessage {
    return {data, id, method, url}
}

export function parseMessage(message: string): WebSocketMessage {
    return JSON.parse(message)
}

export class WebSocketClient extends EventEmitter {
    private ws: WebSocket | null = null

    private activeSubscriptions = new Set<string>()
    private authFailure = false
    private baseReconnectDelay = 100 // 1 second
    private eventHandlers: Record<string, ((data: MessageData) => void)[]> = {}
    private intentionalClose = false
    private maxReconnectAttempts = 10
    private maxReconnectDelay = 30000 // 30 seconds
    private messageListeners: EventListener[] = []
    private pendingRequests = new Map<string, {
        reject: (reason?: unknown) => void
        resolve: (value: MessageData | null) => void
        timeout: ReturnType<typeof setTimeout>
    }>()
    private reconnectAttempts = 0
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
    private requestTimeout = 30000 // 30 seconds
    private url: string
    private messageQueue: {data?: MessageData; id?: string; method?: string; url: string}[] = []

    constructor(baseUrl: string) {
        super()
        if (baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
            this.url = baseUrl
        } else {
            this.url = baseUrl.endsWith('/ws') ? baseUrl : `${baseUrl}/ws`
        }
    }

    addEventListener(type: string, listener: EventListener) {
        if (type === 'message') {
            this.messageListeners.push(listener)
        } else if (this.ws) {
            this.ws.addEventListener(type, listener)
        }
    }

    addSubscription(topic: string) {
        this.activeSubscriptions.add(topic)
    }

    close() {
        logger.debug('[websocket] closing connection intentionally')
        this.intentionalClose = true

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = null
        }

        if (this.ws) {
            this.ws.close()
            this.ws = null
        }
    }

    connect() {
        // Don't try to connect if we're already connecting/connected or had an auth failure
        if (
            this.ws && (
                this.ws.readyState === WebSocket.CONNECTING ||
                this.ws.readyState === WebSocket.OPEN
            )) {
            logger.debug('[websocket] already connected, skipping')
            return
        }

        // Don't reconnect after authentication failures until explicitly told to
        if (this.authFailure) {
            logger.debug('[websocket] Not reconnecting due to previous authentication failure')
            return
        }

        logger.debug(`[websocket] connecting to ${this.url}`)
        this.intentionalClose = false
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
            logger.debug('[websocket] connection established')
            this.reconnectAttempts = 0
            this.emit('open')
            this.processMessageQueue()
        }

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data)

                // Handle request-response messages first
                if (this.handleResponse(message)) return

                this.emit('message', message)

                // Handle route-specific handlers
                if (message.url && this.eventHandlers[message.url]) {
                    this.eventHandlers[message.url].forEach(handler => handler(message.data))
                }

                // Emit on the URL as an event
                if (message.url) {
                    this.emit(message.url, message.data)
                }

                // Pass to generic message listeners
                this.messageListeners.forEach(listener => listener(event))
            } catch (error) {
                logger.error('[websocket] failed to parse message', error)
            }
        }

        this.ws.onclose = (event) => {
            logger.debug(`[websocket] connection closed: code=${event.code}, reason=${event.reason}`)
            this.emit('close', event)

            // Don't reconnect if this was an authentication failure (1008)
            if (event.code === 1008) {
                logger.debug('[websocket] authentication failed; not reconnecting')
                this.authFailure = true
                this.emit('unauthorized', event)
                return // Don't reconnect - authentication required
            }

            // Don't reconnect if this was an intentional close
            if (this.intentionalClose) {
                logger.debug('[websocket] connection closed intentionally; not reconnecting')
                return
            }

            this.reconnect()
        }

        this.ws.onerror = (error) => {
            logger.error('[websocket] connection error', error)
            this.emit('error', error)
        }
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    private reconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = null
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.warn(`[websocket] max reconnection attempts (${this.maxReconnectAttempts}) reached; giving up`)
            this.emit('max_reconnect_attempts')
            return
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(1.5, this.reconnectAttempts),
            this.maxReconnectDelay,
        )

        this.reconnectAttempts++
        logger.debug(`[websocket] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
        this.emit('reconnecting', {attempt: this.reconnectAttempts, delay})

        this.reconnectTimeout = setTimeout(() => {
            this.connect()
        }, delay)
    }



    removeEventListener(type: string, listener: EventListener) {
        if (type === 'message') {
            this.messageListeners = this.messageListeners.filter(l => l !== listener)
        } else if (this.ws) {
            this.ws.removeEventListener(type, listener)
        }
    }

    resetAuthFailure() {
        logger.debug('[websocket] resetting authentication failure state')
        this.authFailure = false
        this.reconnectAttempts = 0
        this.connect()
    }

    private processMessageQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift()
            if (message) {
                if (message.method) {
                    // Don't create a new request, just send the queued message with its existing ID
                    const wsMessage = constructMessage(message.url, message.data, message.id, message.method)
                    if (this.ws) {
                        this.ws.send(JSON.stringify(wsMessage))
                    }
                } else {
                    this.send(message.url, message.data)
                }
            }
        }
    }

    private handleResponse(message: WebSocketMessage) {
        if (!message.id) return false

        logger.debug(`[websocket] received message with id: ${message.id}`)
        const pending = this.pendingRequests.get(message.id)
        if (!pending) {
            logger.debug(`[websocket] no pending request found for id: ${message.id}`)
            return false
        }

        logger.debug(`[websocket] resolving pending request: ${message.id}`)
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(message.id)
        pending.resolve(message.data || null)
        return true
    }

    private async request(method: string, url: string, data?: MessageData): Promise<MessageData | null> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                logger.debug('[websocket] connection not open, queuing request')
                // Instead of resolving null immediately, queue both the message and its promise handlers
                const id = Math.random().toString(36).substring(2, 15)
                logger.debug('[websocket] generated request id for queue:', id)
                this.messageQueue.push({data, id, method, url})

                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(id)
                    reject(new Error('Request timeout while waiting for connection'))
                }, this.requestTimeout)

                this.pendingRequests.set(id, {
                    reject,
                    resolve,
                    timeout,
                })
                return
            }

            const id = Math.random().toString(36).substring(2, 15)
            logger.debug(`[websocket] sending request with id: ${id}`)
            const message = constructMessage(url, data, id, method)

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id)
                reject(new Error(`Request timeout for: ${url}`))
            }, this.requestTimeout)

            this.pendingRequests.set(id, {
                reject,
                resolve,
                timeout,
            })
            this.ws.send(JSON.stringify(message))
        })
    }

    // REST-like methods
    async get(url: string, data?: MessageData) {
        return this.request('GET', url, data)
    }

    async post(url: string, data?: MessageData) {
        return this.request('POST', url, data)
    }

    async put(url: string, data?: MessageData) {
        return this.request('PUT', url, data)
    }

    async delete(url: string, data?: MessageData) {
        return this.request('DELETE', url, data)
    }

    // Original send method for non-request-response messages (like subscriptions)
    send(url: string, data?: MessageData) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.debug('[websocket] connection not open, queuing message')
            this.messageQueue.push({data, url})
            return
        }

        const message = constructMessage(url, data)
        this.ws.send(JSON.stringify(message))
    }
}

export const WebSocketEvents = {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    MESSAGE: 'message',
    OPEN: 'open',
    RECONNECTING: 'reconnecting',
    UNAUTHORIZED: 'unauthorized',
}
