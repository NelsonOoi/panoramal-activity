// Word normalisation shared by guest alignment (align.ts) and alert detection (actors/camera.ts). Owner: track A.
// Pure functions only: this file is bundled into the actor runtime.

export const STOP = new Set(["the", "and", "with", "from", "into", "onto", "their", "his", "her", "person", "someone", "near", "towards", "toward",
    "standing", "walking", "looking", "yellow", "red", "blue", "black", "white", "green", "grey", "gray", "brown", "pink", "orange", "purple",
    "small", "large", "big", "little"])

// Synonyms → one token, so "tote" matches "bag" and "left" matches "exits".
const SYN: Record<string, string> = {}
for (const [token, list] of Object.entries({
    bag: "bag tote backpack purse handbag satchel suitcase luggage",
    phone: "phone mobile smartphone cellphone",
    laptop: "laptop computer notebook macbook",
    box: "box package parcel",
    // clothing (for appearance re-ID)
    shirt: "shirt tee tshirt top blouse polo",
    hoodie: "hoodie hoody sweatshirt jumper sweater pullover fleece",
    jacket: "jacket coat blazer parka windbreaker",
    trousers: "trousers pants jeans chinos slacks joggers leggings",
    hat: "hat cap beanie",
    leave: "leave leaves left exit exits"
})) for (const w of list.split(" ")) SYN[w] = token

// Crude stemmer: picks/picked/picking → pick.
export function stem(w: string): string {
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2)
    if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2)
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
    return w
}

export function normWords(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(w => w.length >= 3 && !STOP.has(w))
        .map(w => SYN[w] ?? SYN[stem(w)] ?? stem(w))
        .filter(w => w.length >= 3 && !STOP.has(w))
}

// Only these can be "gone" / "left unattended" (normalised tokens).
const VALUABLE = new Set(["bag", "laptop", "box", "helmet"])
// Never alert on these even when combined with a valuable word ("laptop keyboard", "phone box").
const NOT_VALUABLE = new Set(["phone", "bottle", "cup", "mug", "glass", "keyboard", "mouse", "pen", "pencil", "paper", "notepad", "book",
    "table", "desk", "chair", "door", "wall", "window", "floor", "screen", "monitor", "light", "lamp", "plant", "sign", "cable", "charger"])

export function isValuable(label: string): boolean {
    const w = normWords(label)
    return w.some(x => VALUABLE.has(x)) && !w.some(x => NOT_VALUABLE.has(x))
}
