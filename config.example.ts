export type Config = {
	defaultPath: string;
	collections: Record<string, string>;
};

const config: Config = {
	defaultPath: "./records",
	collections: {},
};

export default config;
