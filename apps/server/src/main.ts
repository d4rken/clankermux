/**
 * Entry point of the compiled `clankermux-server` binary.
 *
 *   clankermux-server [--port <n>] [--ssl-key <file>] [--ssl-cert <file>]
 *   clankermux-server auth password --set|--clear|--status [--db-path <file>]
 *
 * Both branches import lazily so `auth` never evaluates ./server;
 * __tests__/main-auth-subcommand.test.ts pins that.
 */

const AUTH_USAGE =
	"Usage: clankermux-server auth password --set|--clear|--status [--db-path <file>]";

const argv = process.argv.slice(2);

if (argv[0] === "auth") {
	if (argv[1] === "password") {
		const { runAuthPasswordCli } = await import("@clankermux/http-api");
		process.exit(
			await runAuthPasswordCli(
				argv.slice(2),
				"clankermux-server auth password",
			),
		);
	}
	console.error(AUTH_USAGE);
	process.exit(1);
} else {
	const { runServerFromArgv } = await import("./server");
	runServerFromArgv(argv);
}
