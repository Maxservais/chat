import { Link } from '@tanstack/react-router'
import { Calendar } from 'lucide-react'

export default function Header() {
  return (
    <header className="px-4 py-3 flex items-center bg-slate-900 text-white shadow-lg">
      <Link to="/chat" className="flex items-center gap-2">
        <Calendar size={22} className="text-violet-400" />
        <span className="text-lg font-semibold">EthCC Planner</span>
      </Link>
    </header>
  )
}
