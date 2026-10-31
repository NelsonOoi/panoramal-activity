// Hand-built shadcn-style primitives (dark zinc). No component library.
import { useEffect, useRef } from "react"
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react"
import { X } from "lucide-react"

export function cn(...xs: (string | false | null | undefined)[]) {
    return xs.filter(Boolean).join(" ")
}

type ButtonVariant = "outline" | "primary" | "ghost"
type ButtonSize = "md" | "sm" | "icon" | "icon-sm"
export function Button({
    variant = "outline",
    size = "md",
    className,
    type = "button",
    ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
    return (
        <button
            type={type}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium whitespace-nowrap",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
                variant === "primary" && "border-primary bg-primary text-primary-fg hover:bg-primary-hover",
                variant === "outline" && "border-border bg-transparent hover:bg-muted",
                variant === "ghost" && "border-transparent bg-transparent text-muted-fg hover:bg-muted hover:text-foreground",
                size === "md" && "h-9 px-3.5",
                size === "sm" && "h-8 px-3 text-[13px]",
                size === "icon" && "size-9",
                size === "icon-sm" && "size-7",
                className
            )}
            {...rest}
        />
    )
}

type BadgeVariant = "outline" | "solid" | "secondary" | "destructive"
export function Badge({ variant = "outline", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
    return (
        <span
            className={cn(
                "inline-flex h-[22px] shrink-0 items-center rounded-md border px-2 text-xs font-medium whitespace-nowrap",
                variant === "outline" && "border-border text-muted-fg",
                variant === "solid" && "border-primary bg-primary text-primary-fg",
                variant === "secondary" && "border-transparent bg-secondary text-foreground",
                variant === "destructive" && "border-transparent bg-destructive text-destructive-fg",
                className
            )}
            {...rest}
        />
    )
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
    return <section className={cn("flex min-w-0 flex-col rounded-[10px] border border-border bg-card", className)} {...rest} />
}
export function CardHeader({ title, description, right, className }: { title: ReactNode; description?: ReactNode; right?: ReactNode; className?: string }) {
    return (
        <div className={cn("flex items-start gap-3 px-[18px] pt-4", className)}>
            <div className="min-w-0 grow">
                <div className="text-[15px] leading-tight font-semibold">{title}</div>
                {description && <div className="text-[13px] text-muted-fg">{description}</div>}
            </div>
            {right}
        </div>
    )
}
export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-col gap-3 px-[18px] pt-4 pb-[18px]", className)} {...rest} />
}

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("rounded-lg border border-border px-3.5 py-3", className)} {...rest} />
}
export function Label({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("text-[13px] font-medium", className)} {...rest} />
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn("h-3 animate-skeleton rounded-md bg-muted", className)} />
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            className={cn(
                "h-9 w-full rounded-lg border border-input bg-transparent px-3 outline-none placeholder:text-subtle focus:border-ring focus:shadow-[0_0_0_3px_rgba(212,212,216,0.12)]",
                className
            )}
            {...rest}
        />
    )
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            className={cn(
                "min-h-20 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 outline-none placeholder:text-subtle focus:border-ring focus:shadow-[0_0_0_3px_rgba(212,212,216,0.12)]",
                className
            )}
            {...rest}
        />
    )
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
    return (
        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 font-medium hover:bg-hover">
            <input type="checkbox" className="size-4 accent-[#fafafa]" checked={checked} onChange={e => onChange(e.target.checked)} />
            {label}
        </label>
    )
}

export function Segmented<T extends string>({ value, options, onChange, labelledBy }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; labelledBy?: string }) {
    return (
        <div role="group" aria-labelledby={labelledBy} className="inline-flex flex-wrap gap-0.5 self-start rounded-lg bg-muted p-[3px]">
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={o.value === value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "h-[30px] cursor-pointer rounded-md px-3 font-medium",
                        o.value === value ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.4)]" : "text-muted-fg hover:text-foreground"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}

export function CloseButton({ onClick, label = "Close", small }: { onClick: () => void; label?: string; small?: boolean }) {
    return (
        <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn("ml-auto grid shrink-0 cursor-pointer place-items-center rounded-md text-muted-fg hover:bg-muted hover:text-foreground", small ? "size-7" : "size-8")}
        >
            <X size={small ? 14 : 16} />
        </button>
    )
}

export function Dialog({
    open,
    onClose,
    size = "lg",
    labelledBy,
    children
}: {
    open: boolean
    onClose: () => void
    size?: "lg" | "sm"
    labelledBy?: string
    children: ReactNode
}) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const k = (e: KeyboardEvent) => e.key === "Escape" && onClose()
        window.addEventListener("keydown", k)
        return () => window.removeEventListener("keydown", k)
    }, [open, onClose])
    if (!open) return null
    return (
        <div
            className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-6"
            onMouseDown={e => {
                if (e.target === e.currentTarget) onClose()
            }}
        >
            <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                className={cn(
                    "scroll-thin max-h-[calc(100vh-48px)] overflow-auto rounded-xl border border-border bg-background shadow-[0_4px_12px_rgba(0,0,0,0.4)]",
                    size === "lg" ? "w-[min(1120px,100%)]" : "w-[min(520px,100%)]"
                )}
            >
                {children}
            </div>
        </div>
    )
}
export function DialogHeader({ title, description, onClose, id, extra }: { title: ReactNode; description?: ReactNode; onClose: () => void; id?: string; extra?: ReactNode }) {
    return (
        <div className="flex items-start gap-2.5 px-[22px] pt-5">
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <div id={id} className="text-[17px] font-semibold">
                        {title}
                    </div>
                    {extra}
                </div>
                {description && <div className="text-[13px] text-muted-fg">{description}</div>}
            </div>
            <CloseButton onClick={onClose} />
        </div>
    )
}

export function Logo({ size = 24 }: { size?: number }) {
    return <img src="/favicon.svg" alt="" width={size} height={size} className="shrink-0" />
}
