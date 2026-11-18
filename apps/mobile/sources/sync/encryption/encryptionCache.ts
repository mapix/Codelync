import { AgentState, Metadata, MachineMetadata } from '../storageTypes';
import { DecryptedMessage } from '../storageTypes';

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses messageId as key for messages (immutable)
 */
export class EncryptionCache {
    private agentStateCache = new Map<string, AgentState>();
    private metadataCache = new Map<string, Metadata>();
    private messageCache = new Map<string, DecryptedMessage>();
    private machineMetadataCache = new Map<string, MachineMetadata>();
    private daemonStateCache = new Map<string, any>();
    
    // Configuration
    private readonly maxAgentStates = 1000;
    private readonly maxMetadata = 1000;
    private readonly maxMessages = 1000;
    private readonly maxMachineMetadata = 500;
    private readonly maxDaemonStates = 500;

    private getEntry<T>(cache: Map<string, T>, key: string): T | null {
        const entry = cache.get(key);
        if (entry === undefined) {
            return null;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry;
    }

    private setEntry<T>(cache: Map<string, T>, key: string, value: T, maxSize: number): void {
        if (maxSize <= 0) {
            return;
        }
        if (cache.has(key)) {
            cache.delete(key);
        } else {
            while (cache.size >= maxSize) {
                const oldestKey = cache.keys().next().value;
                if (oldestKey === undefined) {
                    break;
                }
                cache.delete(oldestKey);
            }
        }
        cache.set(key, value);
    }

    private clearScopedEntries<T>(cache: Map<string, T>, scopeId: string): void {
        const prefix = `${scopeId}:`;
        for (const key of cache.keys()) {
            if (key.startsWith(prefix) && key.indexOf(':', prefix.length) === -1) {
                cache.delete(key);
            }
        }
    }

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(sessionId: string, version: number): AgentState | null {
        return this.getEntry(this.agentStateCache, `${sessionId}:${version}`);
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(sessionId: string, version: number, data: AgentState): void {
        this.setEntry(this.agentStateCache, `${sessionId}:${version}`, data, this.maxAgentStates);
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(sessionId: string, version: number): Metadata | null {
        return this.getEntry(this.metadataCache, `${sessionId}:${version}`);
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(sessionId: string, version: number, data: Metadata): void {
        this.setEntry(this.metadataCache, `${sessionId}:${version}`, data, this.maxMetadata);
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(messageId: string): DecryptedMessage | null {
        return this.getEntry(this.messageCache, messageId);
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(messageId: string, data: DecryptedMessage): void {
        this.setEntry(this.messageCache, messageId, data, this.maxMessages);
    }

    /**
     * Get cached machine metadata
     */
    getCachedMachineMetadata(machineId: string, version: number): MachineMetadata | null {
        return this.getEntry(this.machineMetadataCache, `${machineId}:${version}`);
    }

    /**
     * Cache machine metadata
     */
    setCachedMachineMetadata(machineId: string, version: number, data: MachineMetadata): void {
        this.setEntry(this.machineMetadataCache, `${machineId}:${version}`, data, this.maxMachineMetadata);
    }

    /**
     * Get cached daemon state
     */
    getCachedDaemonState(machineId: string, version: number): any | undefined {
        const key = `${machineId}:${version}`;
        if (!this.daemonStateCache.has(key)) {
            return undefined;
        }
        const entry = this.daemonStateCache.get(key);
        this.daemonStateCache.delete(key);
        this.daemonStateCache.set(key, entry);
        return entry;
    }

    /**
     * Cache daemon state (including null values)
     */
    setCachedDaemonState(machineId: string, version: number, data: any): void {
        this.setEntry(this.daemonStateCache, `${machineId}:${version}`, data, this.maxDaemonStates);
    }

    /**
     * Clear all cache entries for a specific machine
     */
    clearMachineCache(machineId: string): void {
        // Clear machine metadata and daemon state for this machine (all versions)
        this.clearScopedEntries(this.machineMetadataCache, machineId);
        this.clearScopedEntries(this.daemonStateCache, machineId);
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSessionCache(sessionId: string): void {
        // Clear agent state and metadata for this session (all versions)
        this.clearScopedEntries(this.agentStateCache, sessionId);
        this.clearScopedEntries(this.metadataCache, sessionId);
        
        // Note: We don't clear messages as they're immutable and session-agnostic
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
        this.machineMetadataCache.clear();
        this.daemonStateCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            machineMetadata: this.machineMetadataCache.size,
            daemonStates: this.daemonStateCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size + 
                         this.machineMetadataCache.size + this.daemonStateCache.size
        };
    }
}