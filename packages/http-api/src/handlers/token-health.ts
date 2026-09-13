import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import {
	checkAllAccountsHealth,
	checkRefreshTokenHealth,
} from "@clankermux/proxy";

/**
 * Create a token health handler for all accounts
 */
export function createTokenHealthHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const accounts = await dbOps.getAllAccounts();
		const healthReport = checkAllAccountsHealth(accounts);

		return jsonResponse({
			success: true,
			data: healthReport,
		});
	};
}

/**
 * Create account token health handler
 */
export function createAccountTokenHealthHandler(
	dbOps: DatabaseOperations,
	accountName: string,
) {
	return async (): Promise<Response> => {
		// Validate account name parameter - allow common characters
		// Account names can contain alphanumeric, spaces, hyphens, underscores, and dots
		if (!accountName || accountName.trim().length === 0) {
			return jsonResponse(
				{
					success: false,
					error: "Account name cannot be empty",
				},
				400,
			);
		}

		// Find account by name from all accounts
		const accounts = await dbOps.getAllAccounts();
		const account = accounts.find((a) => a.name === accountName);

		if (!account) {
			return jsonResponse(
				{
					success: false,
					error: `Account '${accountName}' not found`,
				},
				404,
			);
		}

		const tokenHealth = checkRefreshTokenHealth(account);

		return jsonResponse({
			success: true,
			data: tokenHealth,
		});
	};
}
