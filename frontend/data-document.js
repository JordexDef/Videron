import {Text} from './vendor/codemirror/editor-core.js'

const lineBreak = /\r\n?|\n/
export const textDocument = source => Text.of(source.split(lineBreak))

// Large imports and transforms must leave time for painting and cancellation.
export async function buildDataDocument(source, signal) {
  let result = Text.empty, start = 0, deadline = performance.now() + 8
  const chunkSize = 128 * 1024
  do {
    if (signal.aborted) throw new DOMException('Cancelled','AbortError')
    let end = Math.min(start + chunkSize, source.length)
    if (source.charCodeAt(end-1) === 13 && source.charCodeAt(end) === 10) end++
    result = result.append(textDocument(source.slice(start,end)))
    start = end
    if (start < source.length && performance.now() >= deadline) {
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield()
      else await new Promise(resolve => setTimeout(resolve,0))
      deadline = performance.now() + 8
    }
  } while (start < source.length)
  return result
}
