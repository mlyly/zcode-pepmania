/**
 * Client-side cryptography for encrypted backups (AGENTS.md §2.1: all data —
 * including passwords and keys — stays in the browser; nothing is transmitted).
 *
 * Envelope format (serialized as JSON in `*.enc.json` files):
 *
 * ```json
 * {
 *   "app": "pepmania-pwa",
 *   "kind": "pepmania-encrypted-export",
 *   "v": 1,
 *   "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
 *   "cipher": { "name": "AES-GCM", "iv": "<b64>" },
 *   "plaintextFormat": "json",
 *   "ciphertext": "<b64>"
 * }
 * ```
 *
 * The plaintext is the plain export payload JSON (checksummed), so integrity is
 * verified twice: AES-GCM authenticates the ciphertext, and the inner payload's
 * SHA-256 checksum catches any tampering with the plaintext itself.
 */

import {EXPORT_APP_ID} from "./export";

/** OWASP-recommended PBKDF2-SHA256 iteration count (per-key derivation). */
const PBKDF2_ITERATIONS = 600_000;

const IV_BYTES = 12; // 96-bit IV — standard for AES-GCM.
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

export const ENVELOPE_KIND = "pepmania-encrypted-export";
export const ENVELOPE_VERSION = 1;

export type CryptoErrorCode =
    | "unsupported-browser"
    | "empty-password"
    | "malformed-envelope"
    | "unsupported-envelope"
    | "wrong-password";

export class CryptoError extends Error {
    constructor(message: string, readonly code: CryptoErrorCode) {
        super(message);
        this.name = "CryptoError";
    }
}

export interface EncryptedEnvelope {
    app: string;
    kind: typeof ENVELOPE_KIND;
    v: number;
    kdf: {
        name: "PBKDF2";
        hash: "SHA-256";
        iterations: number;
        salt: string;
    };
    cipher: {
        name: "AES-GCM";
        iv: string;
    };
    /** Identifies what the plaintext contains so future formats can evolve. */
    plaintextFormat: "json";
    ciphertext: string;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

// RegExp-safe alias: DOM's BufferSource requires a plain, non-shared buffer.
type RawBytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
}

function fromBase64(value: string): RawBytes {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function subtle(): SubtleCrypto {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new CryptoError(
            "This browser does not support the Web Crypto API needed for encrypted exports.",
            "unsupported-browser"
        );
    }
    return crypto.subtle;
}

// ---------------------------------------------------------------------------
// Envelope detection
// ---------------------------------------------------------------------------

/** Checks whether a parsed JSON object looks like our encrypted envelope. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<EncryptedEnvelope>;
    return (
        candidate.kind === ENVELOPE_KIND &&
        typeof candidate.v === "number" &&
        typeof candidate.ciphertext === "string" &&
        !!candidate.kdf && !!candidate.cipher
    );
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

async function deriveKey(
    password: string,
    salt: RawBytes,
    iterations: number
): Promise<CryptoKey> {
    const baseKey = await subtle().importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return subtle().deriveKey(
        {name: "PBKDF2", salt, iterations, hash: "SHA-256"},
        baseKey,
        {name: "AES-GCM", length: KEY_LENGTH_BITS},
        false, // non-extractable: the raw key can never be read back.
        ["encrypt", "decrypt"]
    );
}

/** Serializes `value` to JSON and encrypts it under `password`. */
export async function encryptJson(
    value: unknown,
    password: string
): Promise<EncryptedEnvelope> {
    if (!password) {
        throw new CryptoError("A passphrase is required.", "empty-password");
    }

    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await subtle().encrypt({name: "AES-GCM", iv}, key, plaintext);

    return {
        app: EXPORT_APP_ID,
        kind: ENVELOPE_KIND,
        v: ENVELOPE_VERSION,
        kdf: {
            name: "PBKDF2",
            hash: "SHA-256",
            iterations: PBKDF2_ITERATIONS,
            salt: toBase64(salt),
        },
        cipher: {name: "AES-GCM", iv: toBase64(iv)},
        plaintextFormat: "json",
        ciphertext: toBase64(new Uint8Array(ciphertext)),
    };
}

/**
 * Decrypts an envelope back to its JSON plaintext string. `rawJson` may
 * directly be an envelope object or a JSON string containing one.
 */
export async function decryptEnvelope(
    raw: unknown,
    password: string
): Promise<string> {
    if (!password) {
        throw new CryptoError("A passphrase is required.", "empty-password");
    }

    const envelope = raw as Partial<EncryptedEnvelope> | null;
    if (!isEncryptedEnvelope(envelope)) {
        throw new CryptoError("Not a Peptimania encrypted export.", "malformed-envelope");
    }
    if (envelope.v !== ENVELOPE_VERSION) {
        throw new CryptoError(
            `Unsupported envelope version: ${envelope.v}. Update the app.`,
            "unsupported-envelope"
        );
    }
    if (envelope.kdf.name !== "PBKDF2" || envelope.cipher.name !== "AES-GCM") {
        throw new CryptoError(
            "Security parameters are not supported by this app version.",
            "unsupported-envelope"
        );
    }

    let salt: RawBytes;
    let iv: RawBytes;
    let ciphertext: RawBytes;
    try {
        salt = fromBase64(envelope.kdf.salt);
        iv = fromBase64(envelope.cipher.iv);
        ciphertext = fromBase64(envelope.ciphertext);
    } catch {
        throw new CryptoError("Envelope is malformed (bad base64).", "malformed-envelope");
    }

    // A wrong password derives a different key; AES-GCM then fails its
    // authentication check and throws — surfaced to the user as a typo, not a
    // corrupt file.
    try {
        const key = await deriveKey(
            password,
            salt,
            envelope.kdf.iterations ?? PBKDF2_ITERATIONS
        );
        const plaintext = await subtle().decrypt(
            {name: "AES-GCM", iv},
            key,
            ciphertext
        );
        return new TextDecoder().decode(plaintext);
    } catch (error) {
        if (error instanceof CryptoError) throw error;
        throw new CryptoError(
            "Wrong passphrase — decryption failed. Check for typos.",
            "wrong-password"
        );
    }
}

// ---------------------------------------------------------------------------
// Passphrase strength (simple local heuristic — never sent anywhere)
// ---------------------------------------------------------------------------

export interface PasswordStrength {
    /** 0 (very weak) … 4 (strong). */
    score: 0 | 1 | 2 | 3 | 4;
    label: string;
    hints: string[];
}

export function estimatePasswordStrength(password: string): PasswordStrength {
    if (!password) return {score: 0, label: "Empty", hints: []};

    const hints: string[] = [];
    let score = 0;

    if (password.length >= 12) score++;
    else hints.push("use at least 12 characters");
    if (password.length >= 16) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    else hints.push("mix upper and lower case");
    if (/\d/.test(password) || /[^A-Za-z0-9]/.test(password)) score++;
    else hints.push("add digits or symbols");
    if (password.length < 8 && score > 0) score = 0;

    const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;
    return {score: Math.min(4, score) as PasswordStrength["score"], label: labels[Math.min(4, score)], hints};
}
