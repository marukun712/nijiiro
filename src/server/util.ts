export async function withErrorLog<T>(
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		console.error(`[handler] ${name} error:`, err);
		throw err;
	}
}
