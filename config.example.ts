export type Config = {
	defaultPath: string;
	collections: Record<string, string>;
	didDoc: Record<string, unknown>;
};

const config: Config = {
	defaultPath: "./records",
	collections: {},
	didDoc: {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: "did:web:localhost",
		alsoKnownAs: ["at://localhost.local"],
		verificationMethod: [
			{
				id: "did:web:localhost#atproto",
				type: "Multikey",
				controller: "did:web:localhost",
				publicKeyMultibase: "",
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://localhost",
			},
		],
	},
};

export default config;
