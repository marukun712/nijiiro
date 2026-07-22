import type { PrivateKey } from "@atcute/crypto";
import type { Did, Nsid } from "@atcute/lexicons/syntax";
import { isDid, isNsid } from "@atcute/lexicons/syntax";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import { normalize } from "@std/path/posix";
import type { AuthContext } from "./auth.ts";
import { bearerTokenFromRequest, verifyAccessToken } from "./auth.ts";

const APPVIEW_URL = "https://api.bsky.app";
const APPVIEW_DID = "did:web:api.bsky.app" as const;

function nsidFromPath(path: string): Nsid | null {
	const [, prefix, nsid] = path.split("/");
	if (prefix !== "xrpc" || !isNsid(nsid)) return null;
	return nsid;
}

function isXrpcError(err: unknown): err is { status: number } {
	return err instanceof Error && "status" in err;
}

async function proxyToAppView(
	req: Request,
	nsid: Nsid,
	did: Did,
	keypair: PrivateKey,
	auth: AuthContext,
): Promise<Response> {
	const url = new URL(req.url);
	const targetUrl = new URL(url.pathname + url.search, APPVIEW_URL).href;
	const headers = new Headers(req.headers);
	headers.delete("host");

	const token = bearerTokenFromRequest(req);
	if (token) {
		await verifyAccessToken(req, auth);
		const serviceToken = await createServiceJwt({
			keypair,
			issuer: did,
			audience: APPVIEW_DID,
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

const DID_JSON_PATH = new URL("../../well-known/did.json", import.meta.url);

export function createProxyMiddleware(
	next: (req: Request) => Promise<Response> | Response,
	did: string,
	keypair: PrivateKey,
	auth: AuthContext,
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
			const content = await Deno.readTextFile(DID_JSON_PATH);
			return new Response(content, {
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

		if (nsid?.startsWith("app.bsky.") && isDid(did)) {
			console.log("[proxy] forwarding to appview:", nsid);
			try {
				return await proxyToAppView(req, nsid, did, keypair, auth);
			} catch (err) {
				if (isXrpcError(err)) {
					console.log("[proxy] appview error:", err.status, nsid);
					return new Response(
						JSON.stringify({ error: "AuthRequired", message: String(err) }),
						{
							status: err.status,
							headers: { "content-type": "application/json" },
						},
					);
				}
				throw err;
			}
		}

		return next(req);
	};
}
