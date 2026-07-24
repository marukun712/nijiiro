import {
	ComAtprotoServerDescribeServer,
	ComAtprotoServerGetSession,
} from "@atcute/atproto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { json } from "@atcute/xrpc-server";
import { withErrorLog } from "../util.ts";

export function registerServerHandlers(
	router: XRPCRouter,
	did: string,
	handle: string,
	verifyAccessToken: (req: Request) => Promise<{ sub: string } | null>,
) {
	if (!isDid(did)) {
		throw new Error(`configured DID is invalid: ${did}`);
	}
	if (!isHandle(handle)) {
		throw new Error(`configured handle is invalid: ${handle}`);
	}

	router.addQuery(ComAtprotoServerDescribeServer.mainSchema, {
		handler: () =>
			withErrorLog("describeServer", () =>
				Promise.resolve(
					json({
						did,
						availableUserDomains: [],
					}),
				),
			),
	});

	router.addQuery(ComAtprotoServerGetSession.mainSchema, {
		handler: ({ request }) =>
			withErrorLog("getSession", async () => {
				const tokenData = await verifyAccessToken(request);
				if (!tokenData) {
					return new Response(
						JSON.stringify({
							error: "AuthRequired",
							message: "Authentication required",
						}),
						{ status: 401, headers: { "Content-Type": "application/json" } },
					);
				}
				return json({ did, handle, active: true });
			}),
	});
}
