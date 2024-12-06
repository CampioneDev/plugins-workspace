// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

/**
 * Make HTTP requests with the Rust backend.
 *
 * ## Security
 *
 * This API has a scope configuration that forces you to restrict the URLs that can be accessed using glob patterns.
 *
 * For instance, this scope configuration only allows making HTTP requests to all subdomains for `tauri.app` except for `https://private.tauri.app`:
 * ```json
 * {
 *   "permissions": [
 *     {
 *       "identifier": "http:default",
 *       "allow": [{ "url": "https://*.tauri.app" }],
 *       "deny": [{ "url": "https://private.tauri.app" }]
 *     }
 *   ]
 * }
 * ```
 * Trying to execute any API with a URL not configured on the scope results in a promise rejection due to denied access.
 *
 * @module
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Configuration of a proxy that a Client should pass requests to.
 *
 * @since 2.0.0
 */
export interface Proxy {
  /**
   * Proxy all traffic to the passed URL.
   */
  all?: string | ProxyConfig
  /**
   * Proxy all HTTP traffic to the passed URL.
   */
  http?: string | ProxyConfig
  /**
   * Proxy all HTTPS traffic to the passed URL.
   */
  https?: string | ProxyConfig
}

export interface ProxyConfig {
  /**
   * The URL of the proxy server.
   */
  url: string
  /**
   * Set the `Proxy-Authorization` header using Basic auth.
   */
  basicAuth?: {
    username: string
    password: string
  }
  /**
   * A configuration for filtering out requests that shouldn't be proxied.
   * Entries are expected to be comma-separated (whitespace between entries is ignored)
   */
  noProxy?: string
}

/**
 * Options to configure the Rust client used to make fetch requests
 *
 * @since 2.0.0
 */
export interface ClientOptions {
  /**
   * Defines the maximum number of redirects the client should follow.
   * If set to 0, no redirects will be followed.
   */
  maxRedirections?: number
  /** Timeout in milliseconds */
  connectTimeout?: number
  /**
   * Configuration of a proxy that a Client should pass requests to.
   */
  proxy?: Proxy
}

export async function setClientOptions(options: ClientOptions) {
  return await invoke('plugin:http|set_client_options', { options })
}

const ERROR_REQUEST_CANCELLED = 'Request canceled'

export const UNSAFE_HEADER_PREFIX = 'http_unsafe_header_'

/**
 * Fetch a resource from the network. It returns a `Promise` that resolves to the
 * `Response` to that `Request`, whether it is successful or not.
 *
 * @example
 * ```typescript
 * const response = await fetch("http://my.json.host/data.json");
 * console.log(response.status);  // e.g. 200
 * console.log(response.statusText); // e.g. "OK"
 * const jsonData = await response.json();
 * ```
 *
 * @since 2.0.0
 */
export async function fetch(
  input: URL | Request | string,
  init?: RequestInit,
  options?: ClientOptions,
): Promise<Response> {
  // abort early here if needed
  const signal = init?.signal
  if (signal?.aborted) {
    throw new Error(ERROR_REQUEST_CANCELLED)
  }

  const req = new Request(input, init)
  const buffer = await req.arrayBuffer()
  const data =
    buffer.byteLength !== 0 ? Array.from(new Uint8Array(buffer)) : null

  const mappedHeaders: [string,string][] = []

  for (let [key, value] of req.headers.entries()) {
    /**
     * NOTE: This is a workaround that allows us to set the `origin` header,
     * normally forbidden by the browser.
     *
     * The `unsafe-headers` feature of `tauri-plugin-http` must be enabled!
     */
    if (key.startsWith(UNSAFE_HEADER_PREFIX))
      key = key.substring(UNSAFE_HEADER_PREFIX.length)
    mappedHeaders.push([key, value])
  }

  // abort early here if needed
  if (signal?.aborted) {
    throw new Error(ERROR_REQUEST_CANCELLED)
  }

  const rid = await invoke<number>('plugin:http|fetch', {
    clientConfig: {
      method: req.method,
      url: req.url,
      headers: mappedHeaders,
      data,
      options,
    },
  })

  const abort = () => invoke('plugin:http|fetch_cancel', { rid })

  // abort early here if needed
  if (signal?.aborted) {
    // we don't care about the result of this proimse
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    abort()
    throw new Error(ERROR_REQUEST_CANCELLED)
  }

  signal?.addEventListener('abort', () => void abort())

  interface FetchSendResponse {
    status: number
    statusText: string
    headers: [[string, string]]
    url: string
    rid: number
  }

  const {
    status,
    statusText,
    url,
    headers: responseHeaders,
    rid: responseRid
  } = await invoke<FetchSendResponse>('plugin:http|fetch_send', {
    rid
  })

  const body = await invoke<ArrayBuffer | number[]>(
    'plugin:http|fetch_read_body',
    {
      rid: responseRid
    }
  )

  const res = new Response(
    body instanceof ArrayBuffer && body.byteLength !== 0
      ? body
      : body instanceof Array && body.length > 0
        ? new Uint8Array(body)
        : null,
    {
      status,
      statusText
    }
  )

  // url and headers are read only properties
  // but seems like we can set them like this
  //
  // we define theme like this, because using `Response`
  // constructor, it removes url and some headers
  // like `set-cookie` headers
  Object.defineProperty(res, 'url', { value: url })
  Object.defineProperty(res, 'headers', {
    value: new Headers(responseHeaders)
  })

  return res
}
