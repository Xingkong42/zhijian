import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Search } from "lucide-react"

export function pureAdd(a: number, b: number): number {
  return a + b
}
export function Tiny() {
  return <Button>{cn("a", "b")}<Search size={15} /></Button>
}
