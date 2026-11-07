/**
 * How a body of a media type is read. The runtime reads a response by its `Content-Type`
 * with this, and the generator types a response by the spec's media types with it, so
 * the two agree. It isn't part of the package's exports.
 *
 * Server-sent events are a stream, as they don't end while the server has more to say.
 */
export function formatOfMediaType(mediaType: string): 'json' | 'text' | 'bytes' | 'stream' {
	if (/[/+]json\b/i.test(mediaType)) {
		return 'json';
	}
	if (/^text\/event-stream\b/i.test(mediaType)) {
		return 'stream';
	}
	return /^text\/|ndjson/i.test(mediaType) ? 'text' : 'bytes';
}
