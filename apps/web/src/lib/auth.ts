import { type NextRequest, NextResponse } from "next/server";
import { getUserByFirebaseUid, upsertUser } from "./pg";

const IS_DEV = process.env.NODE_ENV !== "production";
const HAS_SERVICE_ACCOUNT = !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

// Lazy-initialize Firebase Admin only when we have credentials
let firebaseAdminInitialized = false;

async function initFirebaseAdmin() {
  if (firebaseAdminInitialized) return;
  firebaseAdminInitialized = true;

  const { initializeApp, getApps, cert } = await import("firebase-admin/app");
  if (getApps().length > 0) return;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccount) {
    initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
  }
}

export interface AuthUser {
  firebaseUid: string;
  userId: string; // internal Postgres UUID
}

// Dev user constants
const DEV_FIREBASE_UID = "dev-local-user";
const DEV_EMAIL = "dev@localhost";
const DEV_NAME = "Dev User";

/**
 * Get or create the dev user in Postgres.
 */
async function getOrCreateDevUser(): Promise<AuthUser> {
  let user = await getUserByFirebaseUid(DEV_FIREBASE_UID);
  if (!user) {
    user = await upsertUser({
      firebaseUid: DEV_FIREBASE_UID,
      name: DEV_NAME,
      email: DEV_EMAIL,
    });
  }
  return { firebaseUid: DEV_FIREBASE_UID, userId: user.id };
}

/**
 * Verify Firebase ID token from Authorization header.
 * In dev mode without service account, returns a dev user.
 */
export async function getAuthUser(
  req: NextRequest
): Promise<AuthUser | null> {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  // No service account key (dev or demo).
  // If a real Firebase ID token is present, decode it and trust the UID
  // (insecure — no signature verification — but matches the demo policy).
  // Otherwise, fall back to the shared dev-local-user in dev mode only.
  if (!HAS_SERVICE_ACCOUNT) {
    if (token) {
      try {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1], "base64").toString()
        );
        const uid = payload.user_id || payload.sub;
        if (uid) {
          let user = await getUserByFirebaseUid(uid);
          if (!user) {
            user = await upsertUser({
              firebaseUid: uid,
              name: payload.name || "User",
              email: payload.email || "",
              photoUrl: payload.picture,
            });
          }
          return { firebaseUid: uid, userId: user.id };
        }
      } catch {
        /* fall through to dev fallback */
      }
    }
    if (IS_DEV) return getOrCreateDevUser();
    return null;
  }

  // Production with service account: verify properly
  if (!token) return null;

  try {
    await initFirebaseAdmin();
    const { getAuth } = await import("firebase-admin/auth");
    const decoded = await getAuth().verifyIdToken(token);
    let user = await getUserByFirebaseUid(decoded.uid);
    if (!user) {
      // Auto-create user on first auth
      user = await upsertUser({
        firebaseUid: decoded.uid,
        name: decoded.name || "User",
        email: decoded.email || "",
        photoUrl: decoded.picture,
      });
    }
    return { firebaseUid: decoded.uid, userId: user.id };
  } catch {
    return null;
  }
}

/**
 * Require authentication. Returns AuthUser or a 401 response.
 */
export async function requireAuth(
  req: NextRequest
): Promise<AuthUser | NextResponse> {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return user;
}

/**
 * Helper: check if result is a NextResponse (error) or AuthUser.
 */
export function isAuthError(
  result: AuthUser | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}
