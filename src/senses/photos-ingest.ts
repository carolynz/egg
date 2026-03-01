import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  EGG_MEMORY_DIR,
  PHOTOS_INGEST_INTERVAL_MS,
  QUIET_START,
  QUIET_END,
} from "../config.js";
import { PHOTOS_INGEST_LOG } from "../logger.js";

const PHOTOS_DB = join(
  homedir(),
  "Pictures",
  "Photos Library.photoslibrary",
  "database",
  "Photos.sqlite",
);
const CURSOR_FILE = join(EGG_MEMORY_DIR, "data", "photos-ingest-cursor.json");
const PHOTOS_DIR = join(EGG_MEMORY_DIR, "data", "photos");
const PHOTOS_LIBRARY = join(homedir(), "Pictures", "Photos Library.photoslibrary");

// Core Data epoch: 2001-01-01T00:00:00Z
const CORE_DATA_EPOCH_MS = Date.parse("2001-01-01T00:00:00Z");

interface PhotosCursor {
  lastZPK: number;
  lastRunAt: string;
}

interface PhotoMetadata {
  zpk: number;
  uuid: string;
  filename: string;
  dateTaken: string;
  latitude: number | null;
  longitude: number | null;
  pixelWidth: number;
  pixelHeight: number;
  kind: "screenshot" | "selfie" | "photo";
  albums: string[];
  localPath: string;
}

function logIngest(message: string): void {
  console.log(`[photos-ingest] ${message}`);
  try {
    mkdirSync(join(homedir(), ".egg", "logs"), { recursive: true });
    appendFileSync(PHOTOS_INGEST_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function loadCursor(): PhotosCursor {
  try {
    if (existsSync(CURSOR_FILE)) {
      return JSON.parse(readFileSync(CURSOR_FILE, "utf-8"));
    }
  } catch {}
  return { lastZPK: 0, lastRunAt: "" };
}

function saveCursor(cursor: PhotosCursor): void {
  try {
    mkdirSync(join(EGG_MEMORY_DIR, "data"), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch (err) {
    logIngest(`ERROR saving cursor: ${err}`);
  }
}

function coreDataToISO(timestamp: number | null): string {
  if (timestamp == null) return new Date().toISOString();
  return new Date(timestamp * 1000 + CORE_DATA_EPOCH_MS).toISOString();
}

function coreDataToDateStr(timestamp: number | null): string {
  return coreDataToISO(timestamp).slice(0, 10);
}

function classifyPhoto(
  kindSubtype: number | null,
  cameraDevice: number | null,
): "screenshot" | "selfie" | "photo" {
  if (kindSubtype === 2) return "screenshot";
  if (cameraDevice === 1) return "selfie";
  return "photo";
}

/**
 * Discover the junction table linking ZGENERICALBUM to ZASSET.
 * The table/column names vary by macOS schema version.
 */
function findAlbumJunction(
  db: Database.Database,
): { table: string; albumCol: string; assetCol: string } | null {
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Z_%ASSETS'")
      .all() as { name: string }[];

    for (const { name } of tables) {
      const cols = db.pragma(`table_info('${name}')`) as { name: string }[];
      const colNames = cols.map((c) => c.name);
      const albumCol = colNames.find((c) => /^Z_\d+ALBUMS$/.test(c));
      const assetCol = colNames.find((c) => /^Z_\d+ASSETS$/.test(c));
      if (albumCol && assetCol) {
        return { table: name, albumCol, assetCol };
      }
    }
  } catch (err) {
    logIngest(`Could not discover album junction table: ${err}`);
  }
  return null;
}

function getAlbumsForAssets(
  db: Database.Database,
  zpks: number[],
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (zpks.length === 0) return result;

  const junction = findAlbumJunction(db);
  if (!junction) return result;

  try {
    const placeholders = zpks.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT j.${junction.assetCol} AS asset_pk, a.ZTITLE AS title
         FROM "${junction.table}" j
         JOIN ZGENERICALBUM a ON a.Z_PK = j.${junction.albumCol}
         WHERE j.${junction.assetCol} IN (${placeholders})
           AND a.ZTITLE IS NOT NULL`,
      )
      .all(...zpks) as { asset_pk: number; title: string }[];

    for (const row of rows) {
      const existing = result.get(row.asset_pk);
      if (existing) {
        existing.push(row.title);
      } else {
        result.set(row.asset_pk, [row.title]);
      }
    }
  } catch (err) {
    logIngest(`Could not fetch album names: ${err}`);
  }
  return result;
}

function buildLocalPath(directory: string | null, filename: string | null): string {
  if (!directory || !filename) return "";
  return join(PHOTOS_LIBRARY, "originals", directory, filename);
}

function queryNewPhotos(db: Database.Database, sinceZPK: number): PhotoMetadata[] {
  const rows = db
    .prepare(
      `SELECT
         a.Z_PK,
         a.ZUUID,
         a.ZFILENAME,
         a.ZDATECREATED,
         a.ZLATITUDE,
         a.ZLONGITUDE,
         a.ZPIXELWIDTH,
         a.ZPIXELHEIGHT,
         a.ZKINDSUBTYPE,
         a.ZDIRECTORY,
         attr.ZCAMERACAPTUREDEVICE
       FROM ZASSET a
       LEFT JOIN ZADDITIONALASSETATTRIBUTES attr ON attr.ZASSET = a.Z_PK
       WHERE a.Z_PK > ?
         AND a.ZTRASHEDSTATE = 0
         AND a.ZVISIBILITYSTATE = 0
       ORDER BY a.Z_PK ASC
       LIMIT 500`,
    )
    .all(sinceZPK) as {
    Z_PK: number;
    ZUUID: string | null;
    ZFILENAME: string | null;
    ZDATECREATED: number | null;
    ZLATITUDE: number | null;
    ZLONGITUDE: number | null;
    ZPIXELWIDTH: number | null;
    ZPIXELHEIGHT: number | null;
    ZKINDSUBTYPE: number | null;
    ZDIRECTORY: string | null;
    ZCAMERACAPTUREDEVICE: number | null;
  }[];

  if (rows.length === 0) return [];

  const zpks = rows.map((r) => r.Z_PK);
  const albumMap = getAlbumsForAssets(db, zpks);

  return rows.map((r) => ({
    zpk: r.Z_PK,
    uuid: r.ZUUID || "",
    filename: r.ZFILENAME || "",
    dateTaken: coreDataToISO(r.ZDATECREATED),
    latitude: r.ZLATITUDE && r.ZLATITUDE !== -180 ? r.ZLATITUDE : null,
    longitude: r.ZLONGITUDE && r.ZLONGITUDE !== -180 ? r.ZLONGITUDE : null,
    pixelWidth: r.ZPIXELWIDTH || 0,
    pixelHeight: r.ZPIXELHEIGHT || 0,
    kind: classifyPhoto(r.ZKINDSUBTYPE, r.ZCAMERACAPTUREDEVICE),
    albums: albumMap.get(r.Z_PK) || [],
    localPath: buildLocalPath(r.ZDIRECTORY, r.ZFILENAME),
  }));
}

function savePhotosByDate(photos: PhotoMetadata[]): void {
  mkdirSync(PHOTOS_DIR, { recursive: true });

  // Group by date
  const byDate = new Map<string, PhotoMetadata[]>();
  for (const photo of photos) {
    const date = photo.dateTaken.slice(0, 10);
    const existing = byDate.get(date);
    if (existing) {
      existing.push(photo);
    } else {
      byDate.set(date, [photo]);
    }
  }

  for (const [date, datePhotos] of byDate) {
    const filePath = join(PHOTOS_DIR, `${date}.json`);
    let existing: PhotoMetadata[] = [];
    try {
      if (existsSync(filePath)) {
        existing = JSON.parse(readFileSync(filePath, "utf-8"));
      }
    } catch {}

    // Deduplicate by zpk
    const seenZPKs = new Set(existing.map((p) => p.zpk));
    const newPhotos = datePhotos.filter((p) => !seenZPKs.has(p.zpk));
    if (newPhotos.length === 0) continue;

    const merged = [...existing, ...newPhotos];
    writeFileSync(filePath, JSON.stringify(merged, null, 2));
    logIngest(`Saved ${newPhotos.length} photo(s) to ${date}.json`);
  }
}

export function runPhotosIngestCycle(): void {
  if (!existsSync(PHOTOS_DB)) {
    logIngest("Photos database not found — skipping");
    return;
  }

  const cursor = loadCursor();
  logIngest(`Checking for new photos since Z_PK ${cursor.lastZPK}`);

  let db: Database.Database;
  try {
    db = new Database(PHOTOS_DB, { fileMustExist: true, readonly: true });
    db.pragma("query_only = ON");
  } catch (err) {
    logIngest(`ERROR opening Photos database: ${err}`);
    return;
  }

  try {
    const photos = queryNewPhotos(db, cursor.lastZPK);

    if (photos.length === 0) {
      logIngest("No new photos");
      return;
    }

    logIngest(`Found ${photos.length} new photo(s)`);
    savePhotosByDate(photos);

    const maxZPK = Math.max(...photos.map((p) => p.zpk));
    saveCursor({ lastZPK: maxZPK, lastRunAt: new Date().toISOString() });
  } catch (err) {
    logIngest(`ERROR during photos ingest: ${err}`);
  } finally {
    db.close();
  }
}

export class PhotosIngestPoller {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    if (!existsSync(PHOTOS_DB)) {
      logIngest("Photos database not found — Photos ingest disabled");
      return;
    }

    const intervalMin = Math.round(PHOTOS_INGEST_INTERVAL_MS / 60_000);
    logIngest(`Photos ingest poller starting (every ${intervalMin} minutes)`);
    // First run after 4 minutes (let other systems initialize)
    setTimeout(() => void this.poll(), 4 * 60_000);
    this.intervalId = setInterval(() => void this.poll(), PHOTOS_INGEST_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const hour = new Date().getHours();
      if (hour >= QUIET_START || hour < QUIET_END) {
        logIngest(`Quiet hours (${QUIET_START}:00–${QUIET_END}:00) — skipping`);
        return;
      }

      runPhotosIngestCycle();
    } catch (err) {
      logIngest(`ERROR in photos ingest poll: ${err}`);
    }
  }
}
