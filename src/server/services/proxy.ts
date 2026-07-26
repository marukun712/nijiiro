import type { PrivateKey } from "@atcute/crypto";
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { AtprotoAudience, Did, Nsid } from "@atcute/lexicons/syntax";
import { isDid, isNsid } from "@atcute/lexicons/syntax";
import { XRPCError } from "@atcute/xrpc-server";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import { normalize } from "@std/path/posix";
import config from "../../../config.ts";

const DEFAULT_APPVIEW_URL = "https://api.bsky.app";
const DEFAULT_APPVIEW_AUDIENCE_STR = "did:web:api.bsky.app#atproto_appview";

function isAtprotoAudience(value: string): value is AtprotoAudience {
	const hashIdx = value.indexOf("#");
	if (hashIdx === -1) return false;
	const potentialDid = value.slice(0, hashIdx);
	if (!isDid(potentialDid)) return false;
	return isResolvableDid(potentialDid);
}

if (!isAtprotoAudience(DEFAULT_APPVIEW_AUDIENCE_STR))
	throw new Error("invalid default appview audience");
const DEFAULT_APPVIEW_AUDIENCE: AtprotoAudience = DEFAULT_APPVIEW_AUDIENCE_STR;

const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver(),
	},
});

function nsidFromPath(path: string): Nsid | null {
	const [, prefix, nsid] = path.split("/");
	if (prefix !== "xrpc" || !isNsid(nsid)) return null;
	return nsid;
}

function isResolvableDid(
	did: Did,
): did is `did:plc:${string}` | `did:web:${string}` {
	return did.startsWith("did:plc:") || did.startsWith("did:web:");
}

async function resolveService(
	service: string,
): Promise<{ did: Did; url: string; audience: Did | AtprotoAudience } | null> {
	const hashIdx = service.indexOf("#");
	if (hashIdx === -1) return null;

	const did = service.slice(0, hashIdx);
	const fragment = service.slice(hashIdx);

	if (!isDid(did) || !isResolvableDid(did)) return null;

	const audience: Did | AtprotoAudience = isAtprotoAudience(service)
		? service
		: did;

	let didDoc: Awaited<ReturnType<typeof didResolver.resolve>>;
	try {
		didDoc = await didResolver.resolve(did);
	} catch {
		return null;
	}

	for (const svc of didDoc.service ?? []) {
		if (svc.id === fragment && typeof svc.serviceEndpoint === "string") {
			return { did, url: svc.serviceEndpoint, audience };
		}
	}
	return null;
}

async function proxyToService(
	req: Request,
	nsid: Nsid,
	did: Did,
	keypair: PrivateKey,
	verifyToken: (req: Request) => Promise<void>,
	serviceUrl: string,
	audience: Did | AtprotoAudience,
): Promise<Response> {
	const url = new URL(req.url);
	const targetUrl = new URL(url.pathname + url.search, serviceUrl).href;
	const headers = new Headers(req.headers);
	headers.delete("host");
	headers.delete("atproto-proxy");

	if (req.headers.get("authorization")) {
		await verifyToken(req);
		const serviceToken = await createServiceJwt({
			keypair,
			issuer: did,
			audience,
			lxm: nsid,
		});
		headers.set("authorization", `Bearer ${serviceToken}`);
	}

	return fetch(targetUrl, {
		method: req.method,
		headers,
		body: req.method !== "GET" && req.method !== "HEAD" ? req.body : null,
	});
}

export function createProxyMiddleware(
	next: (req: Request) => Promise<Response> | Response,
	did: string,
	keypair: PrivateKey,
	verifyToken: (req: Request) => Promise<void>,
): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const url = new URL(req.url);
		const normalizedPathname = normalize(url.pathname);
		if (normalizedPathname !== url.pathname) {
			url.pathname = normalizedPathname;
			req = new Request(url.href, req);
		}
		console.log("[proxy]", req.method, url.pathname);

		if (url.pathname === "/.well-known/did.json") {
			console.log("[proxy] serving did.json");
			return new Response(JSON.stringify(config.didDoc, null, 2), {
				headers: {
					"content-type": "application/json",
					"access-control-allow-origin": "*",
				},
			});
		}

		if (url.pathname === "/.well-known/atproto-did") {
			console.log("[proxy] serving atproto-did");
			return new Response(did, {
				headers: {
					"content-type": "text/plain",
					"access-control-allow-origin": "*",
				},
			});
		}

		const nsid = nsidFromPath(url.pathname);
		if (!nsid || !isDid(did)) return next(req);

		const proxyHeader = req.headers.get("atproto-proxy");

		let serviceUrl: string;
		let audience: Did | AtprotoAudience;

		if (proxyHeader && !nsid.startsWith("com.atproto.")) {
			const resolved = await resolveService(proxyHeader);
			if (!resolved) {
				return new Response(
					JSON.stringify({
						error: "InvalidRequest",
						message: `unable to resolve service: ${proxyHeader}`,
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			serviceUrl = resolved.url;
			audience = resolved.audience;
		} else if (nsid.startsWith("app.bsky.")) {
			serviceUrl = DEFAULT_APPVIEW_URL;
			audience = DEFAULT_APPVIEW_AUDIENCE;
		} else {
			return next(req);
		}

		console.log("[proxy] forwarding to service:", audience, nsid);
		try {
			return await proxyToService(
				req,
				nsid,
				did,
				keypair,
				verifyToken,
				serviceUrl,
				audience,
			);
		} catch (err) {
			if (err instanceof XRPCError) {
				console.log("[proxy] service error:", err.status, err.error, nsid);
				return new Response(
					JSON.stringify({ error: err.error, message: err.message }),
					{
						status: err.status,
						headers: { "content-type": "application/json" },
					},
				);
			}
			throw err;
		}
	};
}
