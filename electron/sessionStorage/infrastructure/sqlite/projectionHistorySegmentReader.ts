import { Buffer } from 'node:buffer'

export type ProjectionHistorySegmentDescriptor = Readonly<{
  locator: string
  byteLength: number
  payloadDigest: string
  itemCount: number
  encoding?: 'json-item-fragment'
  firstItemIndex?: number
  fragmentIndex?: number
  fragmentCount?: number
}>

/** Lazily decodes one JSON array segment at a time; callers never retain all decoded segments. */
export async function* readProjectionHistorySegmentItems<T>(input: Readonly<{
  segments: readonly ProjectionHistorySegmentDescriptor[]
  itemCount: number
  readVerified(descriptor: ProjectionHistorySegmentDescriptor): Promise<Buffer>
}>): AsyncGenerator<T> {
  let itemIndex = 0
  for (let segmentIndex = 0; segmentIndex < input.segments.length;) {
    const descriptor = input.segments[segmentIndex]!
    const bytes = await input.readVerified(descriptor)
    if (descriptor.encoding !== 'json-item-fragment') {
      if (descriptor.itemCount < 1 || (descriptor.firstItemIndex !== undefined && descriptor.firstItemIndex !== itemIndex)) {
        throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      }
      let payload: unknown
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
      if (!Array.isArray(payload) || payload.length !== descriptor.itemCount) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      for (const item of payload) {
        yield item as T
        itemIndex += 1
      }
      segmentIndex += 1
      continue
    }

    const fragmentCount = descriptor.fragmentCount
    if (descriptor.firstItemIndex !== itemIndex || descriptor.fragmentIndex !== 0 || descriptor.itemCount !== 1 ||
      !Number.isSafeInteger(fragmentCount) || (fragmentCount as number) < 2 || (fragmentCount as number) > 15 ||
      segmentIndex + (fragmentCount as number) > input.segments.length) {
      throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
    }
    const fragments = [bytes]
    for (let fragmentIndex = 1; fragmentIndex < (fragmentCount as number); fragmentIndex += 1) {
      const nextDescriptor = input.segments[segmentIndex + fragmentIndex]!
      const next = await input.readVerified(nextDescriptor)
      if (nextDescriptor.encoding !== 'json-item-fragment' || nextDescriptor.firstItemIndex !== itemIndex ||
        nextDescriptor.fragmentIndex !== fragmentIndex || nextDescriptor.fragmentCount !== fragmentCount || nextDescriptor.itemCount !== 0) {
        throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      }
      fragments.push(next)
    }
    let item: unknown
    try { item = JSON.parse(Buffer.concat(fragments).toString('utf8')) }
    catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
    yield item as T
    itemIndex += 1
    segmentIndex += fragmentCount as number
  }
  if (itemIndex !== input.itemCount) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
}
