/** One entry of `persistence.list()` in either host generation's shape. */
export interface PersistenceListEntry {
    readonly id?: unknown;
    readonly cwd?: unknown;
    readonly header?: {
        readonly id?: unknown;
        readonly cwd?: unknown;
    };
}
/** Injected services the deletion flow depends on (structural, no harness import). */
export interface DeleteSessionDeps {
    persistence: {
        /** The JSONL backend exposes its configured root publicly (`config.root`). */
        config?: {
            root?: string;
        };
        list(): Promise<PersistenceListEntry[]>;
    };
    sessions?: {
        get(id: string): unknown;
        flush(session: unknown): Promise<unknown>;
    };
    agents?: {
        /** 0.1.3 returns an AgentHandle (cancel + whenIdle); 0.1.1/0.1.2 a plain Agent. */
        get(id: string): unknown;
    };
    workspaceRegistry?: {
        list(): readonly {
            detachSession?(id: string): Promise<void>;
        }[];
    };
}
export type DeleteSessionResult = {
    status: 200;
    ok: true;
    deleted: string;
} | {
    status: 404;
    ok: false;
    error: {
        code: 'session-not-found';
        message: string;
    };
} | {
    status: 409;
    ok: false;
    error: {
        code: 'session-busy';
        message: string;
    };
} | {
    status: 500;
    ok: false;
    error: {
        code: 'delete-lookup-failed' | 'delete-failed';
        message: string;
    };
} | {
    status: 503;
    ok: false;
    error: {
        code: 'persistence-unavailable';
        message: string;
    };
};
/**
 * Whether `target` resolves to a path inside `root` (defense against escapes).
 *
 * `path.relative` returns an ABSOLUTE path when the two inputs are on
 * different volumes (Windows different drives: relative('D:\\a','C:\\b') is
 * 'C:\\b'). That value is neither '..' nor '../…'-prefixed nor empty, so the
 * `..` checks alone would classify a foreign-drive target as INSIDE the root
 * and let `rm -r` run on it. An absolute relative path means "a different
 * volume", which is outside by definition. Exported for the path-guard tests.
 */
export declare function isInside(root: string, target: string): boolean;
/**
 * Delete one session: stop it if live, remove its persisted directory, and
 * detach it from every workspace account.
 * @param deps - Injected services; the deletion flow never imports the harness.
 * @param sessionId - The session to delete.
 * @returns A structured result the caller maps to an HTTP response.
 */
export declare function deleteSession(deps: DeleteSessionDeps, sessionId: string): Promise<DeleteSessionResult>;
//# sourceMappingURL=delete-session.d.ts.map