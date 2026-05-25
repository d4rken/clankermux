import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { getLegacyDbPaths, resolveDbPath } from "./paths";

/**
 * Adopt a legacy database file into the current ClankerMux location.
 *
 * The project was renamed ccflare → better-ccflare → ClankerMux. On first run,
 * if no current database exists yet but a legacy one does, we adopt the newest
 * legacy database so the user keeps their stats/analytics/account data.
 *
 * This function:
 * 1. Returns early if the current database already exists (no migration needed)
 * 2. Finds the newest existing legacy database (better-ccflare.db, then ccflare.db)
 * 3. Moves it (and its -wal/-shm sidecars) to the current location
 *
 * Moving uses rename() when source and destination share a filesystem — this is
 * atomic and avoids duplicating a multi-GiB database. Across filesystems (rename
 * throws EXDEV) it falls back to a copy that leaves the legacy files intact.
 *
 * @returns true if a migration was performed, false otherwise
 */
export function migrateFromCcflare(): boolean {
	const newDbPath = resolveDbPath();

	// If new DB already exists, no migration needed
	if (existsSync(newDbPath)) {
		return false;
	}

	// Find the newest legacy DB that actually exists
	const legacyDbPath = getLegacyDbPaths().find((p) => existsSync(p));
	if (!legacyDbPath) {
		return false;
	}

	try {
		// Ensure target directory exists
		const newDbDir = dirname(newDbPath);
		if (!existsSync(newDbDir)) {
			mkdirSync(newDbDir, { recursive: true });
		}

		// Move main database file
		const verb = adoptFile(legacyDbPath, newDbPath);
		console.log(`✅ Migrated database from ${legacyDbPath} to ${newDbPath}`);

		// Move WAL and SHM sidecar files if they exist
		const walPath = `${legacyDbPath}-wal`;
		const shmPath = `${legacyDbPath}-shm`;

		if (existsSync(walPath)) {
			adoptFile(walPath, `${newDbPath}-wal`);
			console.log(`✅ Migrated WAL file`);
		}

		if (existsSync(shmPath)) {
			adoptFile(shmPath, `${newDbPath}-shm`);
			console.log(`✅ Migrated SHM file`);
		}

		if (verb === "copied") {
			console.log(`
⚠️  Migration complete! Your legacy data has been copied to ClankerMux.
   The original files have been left intact for safety.
   You can delete them manually if desired: ${dirname(legacyDbPath)}/
`);
		} else {
			console.log(`
✅ Migration complete! Your legacy data has been moved to ClankerMux.
`);
		}

		return true;
	} catch (error) {
		console.error(`❌ Failed to migrate database: ${error}`);
		return false;
	}
}

/**
 * Move a file to dest. Uses an atomic rename when on the same filesystem;
 * falls back to a copy (leaving the source intact) across filesystems.
 * @returns "moved" if renamed, "copied" if copied across filesystems
 */
function adoptFile(src: string, dest: string): "moved" | "copied" {
	try {
		renameSync(src, dest);
		return "moved";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EXDEV") {
			// Source and destination are on different filesystems — rename can't
			// cross the boundary, so copy instead and leave the source in place.
			copyFileSync(src, dest);
			return "copied";
		}
		throw error;
	}
}
