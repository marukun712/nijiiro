import { ComAtprotoServerDescribeServer } from "@atcute/atproto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { json } from "@atcute/xrpc-server";
import { withErrorLog } from "../util.ts";

export function registerServerHandlers(
	router: XRPCRouter,
	did: string,
	handle: string,
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
}
