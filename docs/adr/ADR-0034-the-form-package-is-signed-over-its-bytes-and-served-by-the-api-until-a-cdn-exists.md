# ADR-0034 — The form package is signed over its exact bytes, and the API serves it until a CDN exists

**Status** Accepted · M6 Track D, M6-24 to M6-27 · Departs from ARCHITECTURE §5.1 and BACKEND-ARCHITECTURE §3 on how the package is served

## Context

ARCHITECTURE §5.1 describes the form package as a signed, immutable bundle served from a CDN, at most 3 MB, never
containing a key; BACKEND-ARCHITECTURE §3 has `GET /v1/forms/{id}/package` answer with a redirect to a signed CDN
URL, "bytes must never traverse the API tier". There is no CDN, no object store and no deployment to put one in. The
package, its signing and the proof that it is key-free can all be built and measured now, and the first two do not
depend on where the bytes are served from.

## Decision

**The package is canonical JSON, byte-identical for the same form, signed over those exact bytes.** It is built from
the item and stimulus *versions the form pinned*, read by version id through content's delivery seam, so it cannot
drift to whatever is current. The signature is Ed25519 over the bytes as sent — never over a parsed form of them — so
a device verifies what it downloaded and a CDN holding the bytes cannot alter them undetected. The digest, signature
and key id travel in headers (`X-Package-Digest`, `X-Package-Signature`, `X-Package-Key-Id`); the digest is also the
`ETag`. The public key is served by `GET /v1/assessment/package-signing-key`.

**The seed is configuration, optional, with no default** (`FORM_PACKAGE_SIGNING_KEY`, 32 bytes, base64). Absent, the
package routes answer `503` and the rest of the application boots; present but malformed, or equal to the auth or
audit key, the application refuses to start. An unsigned package is never served: a device told to trust bytes
nothing vouches for is worse than one told to wait.

**The API serves the bytes, at `/v1/assessment/forms/{formId}/package`, for now.** That is the departure. It is a
route on the assessment surface like the others (ADR-0033), not `/v1/forms/...`, and it answers `200` with the bytes,
not `302` to a CDN. Because the bytes and the signature do not depend on who serves them, moving them behind a CDN
later changes the route's response and nothing about the package (D58).

**Media is carried by reference.** The package holds each item's delivery view; an image is an asset version id in a
content body, a separate download. The 3 MB budget is measured over the package itself (M6-27); the media a question
shows and the CDN that would serve the package are outside that figure and cannot be measured without a deployment.

**No key reaches the package, proven three ways.** A byte scan over a package built for all four item types finds no
key field and no key value, and the same scan over the same items' authoring views finds both — a scan that cannot
find a key where one exists proves nothing. The HTTP integration spec runs the scan over the bytes the route
actually serves. A fitness rule walks the packaging modules' imports and fails if any reaches a module that makes or
carries an answer key.

## Consequences

- The size budget is proved for a 75-item form (279 KiB for the generated form in `form-package-size.spec.ts`, 905 KiB
  at ten times the text) with a case showing the check can fail.
- One signing key, no rotation procedure (D59). The key id is in every response so a client can tell which key signed.
- Every package request is answered by the API tier until D58 is closed, which is the load ARCHITECTURE §5.1's design
  exists to avoid; it is acceptable only while there is no student population.
