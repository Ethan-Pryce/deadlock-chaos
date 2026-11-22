// Vercel serverless function: the shared leaderboard.
//
//   GET  /api/scores  -> JSON array of all entries, best score first
//   POST /api/scores  -> submit one run; returns the saved entry
//
// Storage: Vercel Blob (a *private* store). Each run is its own small JSON file
// under "scores/". Files are only ever added, never rewritten, so simultaneous
// submissions can't overwrite each other and Blob's CDN caching can never serve
// a stale board that then gets written back.
//
// Setup: create a Blob store in the Vercel dashboard and connect it to this
// project. Connecting sets BLOB_STORE_ID; @vercel/blob then authenticates with
// the deployment's automatic OIDC token (older stores use BLOB_READ_WRITE_TOKEN
// instead — both work).

import { put, list, get } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { validate, isStoredEntry, sortEntries } from "./_score.js";

// Must match the store's access setting (deadlock-chaos-blob is private).
const ACCESS = "private";
const PREFIX = "scores/";
const MAX_RETURN = 500;
const FETCH_CONCURRENCY = 20;

function setCors(res) {
  // The GitHub Pages copy of the site calls this API cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function listAllBlobs() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readAllEntries() {
  const blobs = await listAllBlobs();
  const entries = [];
  let i = 0;
  async function worker() {
    while (i < blobs.length) {
      const blob = blobs[i++];
      try {
        // Private blobs can't be fetched by URL; read them through the SDK.
        const r = await get(blob.pathname, { access: ACCESS });
        if (!r || r.statusCode !== 200) continue;
        const e = await new Response(r.stream).json();
        if (isStoredEntry(e)) entries.push(e);
      } catch {
        // Skip unreadable entries rather than failing the whole board.
      }
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return sortEntries(entries).slice(0, MAX_RETURN);
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    return res
      .status(500)
      .json({ error: "Leaderboard storage isn't connected (no Blob store linked to this Vercel project)." });
  }

  try {
    if (req.method === "GET") {
      const entries = await readAllEntries();
      // Short CDN cache keeps Blob operation usage low; new submissions are
      // added to the page client-side right away, so the delay isn't visible.
      res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
      return res.status(200).json(entries);
    }

    if (req.method === "POST") {
      const result = validate(parseBody(req));
      if (!result.ok) return res.status(400).json({ error: result.error });

      const id = randomUUID();
      const entry = { id, date: new Date().toISOString(), ...result.entry };
      await put(`${PREFIX}${Date.now()}-${id}.json`, JSON.stringify(entry), {
        access: ACCESS,
        addRandomSuffix: false,
        contentType: "application/json",
      });
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(entry);
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error("leaderboard error:", err);
    return res.status(500).json({ error: "Leaderboard error. Try again in a moment." });
  }
}
