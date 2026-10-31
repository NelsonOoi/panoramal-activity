import { createRoot } from "react-dom/client"
import "./styles.css"
import { Dashboard } from "./dash/Dashboard"
import { Capture } from "./pages/Capture"
import { Witness } from "./pages/Witness"

const path = location.pathname.replace(/\/+$/, "") || "/"
const page = path.startsWith("/capture") ? <Capture /> : path.startsWith("/witness") ? <Witness /> : <Dashboard />
if (path.startsWith("/capture") || path.startsWith("/witness")) document.documentElement.classList.add("phone")

createRoot(document.getElementById("root")!).render(page)
