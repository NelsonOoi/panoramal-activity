import { useEffect, useState } from "react"
import { Download, Pause, Play, RotateCcw, Trash2 } from "lucide-react"
import type { Player, SourceStatus } from "../lib/source"
import { clearRecording, downloadRecording, recordingLength } from "../lib/source"
import { Button, Input, cn } from "../ui"

export function DevPanel({ status, events, player, mode }: { status: SourceStatus; events: number; player: Player | null; mode: string }) {
    const [, tick] = useState(0)
    useEffect(() => {
        const id = setInterval(() => tick(x => x + 1), 500)
        return () => clearInterval(id)
    }, [])
    const prog = player?.progress()
    const [file, setFile] = useState("")
    return (
        <div className="fixed right-4 bottom-4 z-50 w-[22rem] rounded-xl border border-border bg-background p-4 text-[13px] shadow-[0_4px_12px_rgba(0,0,0,0.4)]">
            <div className="mb-3 flex items-center justify-between">
                <span className="font-semibold">Dev</span>
                <span className="font-mono text-xs text-subtle">press d to hide</span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                <dt className="text-subtle">mode</dt>
                <dd>{mode}</dd>
                <dt className="text-subtle">socket</dt>
                <dd>{status}</dd>
                <dt className="text-subtle">events</dt>
                <dd>{events}</dd>
                <dt className="text-subtle">recorded</dt>
                <dd>{recordingLength()}</dd>
                {prog && (
                    <>
                        <dt className="text-subtle">replay</dt>
                        <dd>
                            {prog.index}/{prog.total} {prog.paused ? "(paused)" : ""} ×{prog.speed}
                        </dd>
                    </>
                )}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={downloadRecording}>
                    <Download size={14} /> Download recording
                </Button>
                <Button size="sm" onClick={clearRecording} aria-label="Clear recording buffer">
                    <Trash2 size={14} />
                </Button>
            </div>
            {player && (
                <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => (prog?.paused ? player.resume() : player.pause())}>
                        {prog?.paused ? <Play size={14} /> : <Pause size={14} />} {prog?.paused ? "Resume" : "Pause"}
                    </Button>
                    <Button size="sm" onClick={() => player.restart()}>
                        <RotateCcw size={14} /> Restart
                    </Button>
                    {[1, 2, 4].map(x => (
                        <Button key={x} size="sm" className={cn(prog?.speed === x && "bg-secondary")} onClick={() => player.setSpeed(x)}>
                            ×{x}
                        </Button>
                    ))}
                </div>
            )}
            <form
                className="mt-3 flex gap-2"
                onSubmit={e => {
                    e.preventDefault()
                    if (file) location.href = `/dash?replay=/recordings/${file.replace(/^\/?(recordings\/)?/, "")}`
                }}
            >
                <Input value={file} onChange={e => setFile(e.target.value)} placeholder="run-….jsonl" className="h-8 font-mono text-xs" />
                <Button size="sm" type="submit">
                    Replay
                </Button>
            </form>
            <div className="mt-2 flex gap-3 text-xs text-muted-fg">
                <a className="underline-offset-4 hover:text-foreground hover:underline" href="/dash?mock=1">
                    mock
                </a>
                <a className="underline-offset-4 hover:text-foreground hover:underline" href="/dash">
                    live
                </a>
            </div>
        </div>
    )
}
