import { createFileRoute } from '@tanstack/react-router'
import AgentChat from '../components/chat/AgentChat'

export const Route = createFileRoute('/chat')({
  ssr: false,
  component: AgentChat,
})
