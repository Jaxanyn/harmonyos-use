export interface CaptureStats { active: number; frames: number; elapsedMs: number; state: number; error: number; releaseError: number; }
export function start(width: number, height: number): number;
export function stats(): CaptureStats;
export function stop(): number;
