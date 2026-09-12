'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase, type Task, type Client, type CallSummary, type DailyItem } from '@/lib/supabase'

type Message = { role: 'user' | 'assistant'; content: string }
type HistoryItem = { role: 'user' | 'assistant'; content: string }
type ActiveTab = 'tasks' | 'daily' | 'calls' | 'chat'
type TaskTab = 'todas' | 'trabalho' | 'pessoal'

const P = {
  alta:  { label: 'Alta',  dot: '#EF4444', dark: '#DC2626', btnCls: 'bg-red-500 text-white',    ringCls: 'ring-red-300' },
  media: { label: 'Média', dot: '#F97316', dark: '#EA580C', btnCls: 'bg-orange-500 text-white', ringCls: 'ring-orange-300' },
  baixa: { label: 'Baixa', dot: '#22C55E', dark: '#16A34A', btnCls: 'bg-green-500 text-white',  ringCls: 'ring-green-300' },
} as const

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function formatDateBR(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function urgencyScore(t: Task) {
  const s = { alta: 3, media: 2, baixa: 1 }[t.priority] ?? 1
  if (!t.deadline) return s * 10
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due = new Date(t.deadline + 'T00:00:00')
  const d = Math.ceil((due.getTime() - today.getTime()) / 86400000)
  return s * 10 + (d <= 0 ? 1000 : d <= 1 ? 500 : d <= 3 ? 200 : d <= 7 ? 100 : 50)
}

function deadlineLabel(deadline: string | null) {
  if (!deadline) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due = new Date(deadline + 'T00:00:00')
  const d = Math.ceil((due.getTime() - today.getTime()) / 86400000)
  const s = due.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  if (d < 0) return { text: `Atrasada · ${s}`, cls: 'text-red-500' }
  if (d === 0) return { text: 'Hoje', cls: 'text-orange-500' }
  if (d === 1) return { text: 'Amanhã', cls: 'text-orange-400' }
  if (d <= 7) return { text: `${d}d · ${s}`, cls: 'text-yellow-600' }
  return { text: s, cls: 'text-gray-400' }
}

function clientNameFromTask(task: Task, clients: Client[]) {
  if (task.client_id) {
    const c = clients.find(c => c.id === task.client_id)
    if (c) return c.name
  }
  const m = task.title.match(/^\[([^\]]+)\]/)
  return m ? m[1] : null
}

// ─── TaskCard ─────────────────────────────────────────────────
function TaskCard({ task, clients, onOpen, onToggle }: {
  task: Task; clients: Client[]; onOpen: () => void; onToggle: () => void
}) {
  const p = P[task.priority]
  const dl = deadlineLabel(task.deadline)
  const done = task.status === 'concluida'
  const clientName = clientNameFromTask(task, clients)

  return (
    <div className={`bg-white rounded-2xl flex items-start gap-3 px-4 py-3.5 transition-opacity ${done ? 'opacity-40' : ''}`}>
      <button onClick={onToggle} className="mt-0.5 shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all"
        style={{ borderColor: done ? '#3B82F6' : '#D1D5DB', background: done ? '#3B82F6' : 'transparent' }}>
        {done && (
          <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
            <path d="M1 3.8L4 6.8L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen}>
        <p className={`text-[15px] font-medium text-gray-900 leading-snug ${done ? 'line-through' : ''}`}>{task.title}</p>
        {task.description && !done && (
          <p className="text-sm text-gray-400 mt-0.5 line-clamp-1">{task.description}</p>
        )}
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {clientName && (
            <span className="text-[11px] font-semibold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">{clientName}</span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.dot }} />
            <span className="text-xs font-medium" style={{ color: p.dark }}>{p.label}</span>
          </span>
          {dl && <span className={`text-xs ${dl.cls}`}>· {dl.text}</span>}
        </div>
      </div>
      <button onClick={onOpen} className="mt-1.5 shrink-0 text-gray-300">
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M1 1L6 6L1 11" stroke="#C7C7CC" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}

// ─── TaskSheet ────────────────────────────────────────────────
function TaskSheet({ task, clients, onClose, onSave, onDelete }: {
  task: Task; clients: Client[]
  onClose: () => void
  onSave: (u: Partial<Task>) => Promise<void>
  onDelete: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description || '')
  const [priority, setPriority] = useState<Task['priority']>(task.priority)
  const [deadline, setDeadline] = useState(task.deadline || '')
  const [category, setCategory] = useState<Task['category']>(task.category)
  const [notes, setNotes] = useState(task.notes || '')
  const [clientId, setClientId] = useState(task.client_id || '')
  const [aiQ, setAiQ] = useState('')
  const [aiA, setAiA] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSave({ title, description: description || null, priority, deadline: deadline || null, category, notes: notes || null, client_id: clientId || null })
    setSaving(false)
    onClose()
  }

  async function askAI() {
    if (!aiQ.trim()) return
    setAiLoading(true)
    try {
      const fd = new FormData()
      fd.append('text', aiQ)
      fd.append('history', JSON.stringify([
        { role: 'user', content: `Contexto da tarefa:\nTítulo: "${task.title}"\nDescrição: "${task.description || ''}"\nPrioridade: ${task.priority}\nPrazo: ${task.deadline || 'sem prazo'}\nNotas: ${task.notes || ''}` },
        { role: 'assistant', content: 'Entendido. Posso responder perguntas sobre essa tarefa ou sugerir próximos passos.' },
      ]))
      const res = await fetch('/api/chat', { method: 'POST', body: fd })
      const data = await res.json()
      setAiA(data.message || 'Sem resposta.')
    } catch { setAiA('Erro ao consultar.') }
    setAiLoading(false)
  }

  const activeClients = clients.filter(c => c.status === 'active')

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-[#F2F2F7] rounded-t-[28px] max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#F2F2F7]/95 backdrop-blur-md z-10 rounded-t-[28px]">
          <div className="flex justify-center pt-3">
            <div className="w-9 h-1 bg-gray-300 rounded-full" />
          </div>
          <div className="flex items-center justify-between px-5 py-3">
            <button onClick={onClose} className="text-blue-500 font-medium text-[15px]">Cancelar</button>
            <span className="font-semibold text-[15px] text-gray-800">Detalhes</span>
            <button onClick={save} disabled={saving} className="text-blue-500 font-semibold text-[15px] disabled:opacity-40">
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>

        <div className="px-4 pb-12 space-y-3 pt-1">
          <section className="bg-white rounded-2xl overflow-hidden divide-y divide-gray-100">
            <div className="px-4 py-3">
              <label className="text-[11px] text-gray-400 uppercase tracking-wider">Título</label>
              <input className="w-full text-[17px] font-medium mt-1 outline-none bg-transparent" value={title} onChange={e => setTitle(e.target.value)} placeholder="Título da tarefa" />
            </div>
            <div className="px-4 py-3">
              <label className="text-[11px] text-gray-400 uppercase tracking-wider">Descrição</label>
              <textarea className="w-full text-[15px] mt-1 outline-none bg-transparent resize-none min-h-[56px] text-gray-600" value={description} onChange={e => setDescription(e.target.value)} placeholder="Detalhes, contexto, links…" />
            </div>
          </section>

          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2.5">Cliente</label>
            <select
              className="w-full text-[15px] text-gray-700 outline-none bg-gray-50 rounded-xl px-3 py-2.5"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
            >
              <option value="">— Sem cliente —</option>
              {activeClients.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </section>

          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2.5">Prioridade</label>
            <div className="flex gap-2">
              {(['alta','media','baixa'] as const).map(v => (
                <button key={v} onClick={() => setPriority(v)}
                  className={`flex-1 py-2.5 rounded-xl text-[14px] font-semibold transition-all ${priority === v ? P[v].btnCls + ' ring-2 ' + P[v].ringCls : 'bg-gray-100 text-gray-500'}`}>
                  {P[v].label}
                </button>
              ))}
            </div>
          </section>

          <section className="bg-white rounded-2xl overflow-hidden divide-y divide-gray-100">
            <div className="px-4 py-3">
              <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-1">Prazo</label>
              <input type="date" className="w-full text-[15px] text-gray-700 outline-none bg-transparent" value={deadline} onChange={e => setDeadline(e.target.value)} />
            </div>
            <div className="px-4 py-3">
              <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2.5">Categoria</label>
              <div className="flex gap-2">
                {(['trabalho','pessoal'] as const).map(c => (
                  <button key={c} onClick={() => setCategory(c)}
                    className={`flex-1 py-2 rounded-xl text-[14px] font-medium transition-all ${category === c ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                    {c === 'trabalho' ? '💼 Trabalho' : '🏠 Pessoal'}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-1">Notas</label>
            <textarea className="w-full text-[15px] mt-1 outline-none bg-transparent resize-none min-h-[80px] text-gray-700 placeholder:text-gray-300"
              placeholder="Links, observações, referências…" value={notes} onChange={e => setNotes(e.target.value)} />
          </section>

          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2">Perguntar à IA</label>
            <div className="flex gap-2">
              <input className="flex-1 text-[15px] bg-gray-50 rounded-xl px-3 py-2 outline-none placeholder:text-gray-300"
                placeholder="Ex: Quais próximos passos?" value={aiQ} onChange={e => setAiQ(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && askAI()} />
              <button onClick={askAI} disabled={aiLoading || !aiQ.trim()}
                className="bg-blue-500 text-white text-[14px] font-semibold px-4 py-2 rounded-xl disabled:opacity-40 whitespace-nowrap">
                {aiLoading ? '…' : 'Enviar'}
              </button>
            </div>
            {aiA && <div className="mt-3 bg-blue-50 rounded-xl p-3 text-[14px] text-gray-700 leading-relaxed">{aiA}</div>}
          </section>

          <button onClick={() => { if (window.confirm('Excluir esta tarefa?')) { onDelete(); onClose() } }}
            className="w-full bg-white rounded-2xl py-4 text-red-500 text-[15px] font-medium active:opacity-70">
            Excluir Tarefa
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── DailyView ────────────────────────────────────────────────
function DailyView() {
  const [date, setDate] = useState(todayISO())
  const [items, setItems] = useState<DailyItem[]>([])
  const [newText, setNewText] = useState('')
  const [adding, setAdding] = useState(false)

  const isFuture = date > todayISO()

  const load = useCallback(async () => {
    const res = await fetch(`/api/daily?date=${date}`)
    const data = await res.json()
    if (Array.isArray(data)) setItems(data)
  }, [date])

  useEffect(() => { load() }, [load])

  async function addItem() {
    if (!newText.trim()) return
    setAdding(true)
    await fetch('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, text: newText.trim() }) })
    setNewText('')
    await load()
    setAdding(false)
  }

  async function toggleItem(item: DailyItem) {
    await fetch('/api/daily', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, done: !item.done }) })
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, done: !i.done } : i))
  }

  return (
    <div className="flex flex-col h-full bg-[#F2F2F7]">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Daily</h1>
        <div className="flex items-center gap-3 mt-2">
          <button onClick={() => setDate(d => addDays(d, -1))} className="w-8 h-8 flex items-center justify-center rounded-full bg-white shadow-sm text-gray-500 active:bg-gray-100">
            <svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M7 1L1 7L7 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div className="flex-1 text-center">
            <p className="text-[15px] font-semibold text-gray-800 capitalize">{formatDateBR(date)}</p>
            {date === todayISO() && <p className="text-[11px] text-blue-500 font-medium">Hoje</p>}
            {isFuture && <p className="text-[11px] text-indigo-500 font-medium">📅 Dia futuro</p>}
          </div>
          <button onClick={() => setDate(d => addDays(d, 1))} className="w-8 h-8 flex items-center justify-center rounded-full bg-white shadow-sm text-gray-500 active:bg-gray-100">
            <svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M1 1L7 7L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2 mt-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-gray-300">
            <p className="text-[15px]">{isFuture ? 'Pré-anote itens para este dia' : 'Nenhum item ainda'}</p>
          </div>
        )}
        {items.map(item => (
          <div key={item.id} className="bg-white rounded-2xl flex items-center gap-3 px-4 py-3">
            <button onClick={() => toggleItem(item)} className="shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all"
              style={{ borderColor: item.done ? '#3B82F6' : '#D1D5DB', background: item.done ? '#3B82F6' : 'transparent' }}>
              {item.done && (
                <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
                  <path d="M1 3.8L4 6.8L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <p className={`flex-1 text-[15px] text-gray-800 ${item.done ? 'line-through text-gray-400' : ''}`}>{item.text}</p>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 bg-[#F2F2F7]">
        <div className="flex gap-2 bg-white rounded-2xl px-4 py-2.5 shadow-sm">
          <input className="flex-1 text-[15px] outline-none bg-transparent placeholder:text-gray-300"
            placeholder="Adicionar item…" value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !adding && addItem()} />
          <button onClick={addItem} disabled={adding || !newText.trim()} className="shrink-0 w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center disabled:opacity-30">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1V13M1 7H13" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── CallsView ────────────────────────────────────────────────
function CallsView({ summaries }: { summaries: CallSummary[] }) {
  return (
    <div className="flex flex-col h-full bg-[#F2F2F7]">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Calls</h1>
        <p className="text-[13px] text-gray-400 mt-0.5">{summaries.length} reunião{summaries.length !== 1 ? 'ões' : ''} resumida{summaries.length !== 1 ? 's' : ''}</p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-3 mt-2">
        {summaries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-300">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="mb-3 opacity-40">
              <path d="M12 2a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M19 10a7 7 0 0 1-14 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <p className="text-[15px]">Nenhum resumo ainda</p>
            <p className="text-[13px] mt-1">Sincronize reuniões na aba Tarefas</p>
          </div>
        )}
        {summaries.map(cs => (
          <div key={cs.id} className="bg-white rounded-2xl px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[15px] font-semibold text-gray-900 flex-1 leading-snug">{cs.doc_name}</p>
              {cs.meeting_date && (
                <span className="text-[11px] text-gray-400 shrink-0 mt-0.5">
                  {new Date(cs.meeting_date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                </span>
              )}
            </div>
            {cs.participants && (
              <p className="text-[12px] text-indigo-500 font-medium mt-1">{cs.participants}</p>
            )}
            <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">{cs.summary}</p>
            {cs.key_points?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {cs.key_points.map((kp, i) => (
                  <li key={i} className="text-[12px] text-gray-500 flex gap-1.5">
                    <span className="text-gray-300 shrink-0">·</span>
                    {kp}
                  </li>
                ))}
              </ul>
            )}
            {cs.action_items_count > 0 && (
              <p className="text-[11px] text-green-600 font-medium mt-2">
                {cs.action_items_count} tarefa{cs.action_items_count !== 1 ? 's' : ''} extraída{cs.action_items_count !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Home ─────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('tasks')
  const [rightTab, setRightTab] = useState<'daily' | 'calls' | 'chat'>('chat')
  const [taskTab, setTaskTab] = useState<TaskTab>('todas')
  const [clientFilter, setClientFilter] = useState<string | null>(null)

  const [tasks, setTasks] = useState<Task[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [callSummaries, setCallSummaries] = useState<CallSummary[]>([])
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [showDone, setShowDone] = useState(false)

  const [quickInput, setQuickInput] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [captureRecording, setCaptureRecording] = useState(false)

  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Olá Ivan! Pode perguntar sobre clientes, calls ou tarefas — ou descreva algo pra criar.' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [recording, setRecording] = useState(false)

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)

  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const captureMediaRef = useRef<MediaRecorder | null>(null)
  const captureChunksRef = useRef<Blob[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HistoryItem[]>([])

  const loadTasks = useCallback(async () => {
    const { data } = await supabase.from('tasks').select('*')
    if (data) setTasks([...data].sort((a, b) => urgencyScore(b) - urgencyScore(a)))
  }, [])

  const loadClients = useCallback(async () => {
    const { data } = await supabase.from('clients').select('*').order('status').order('name')
    if (data) setClients(data)
  }, [])

  const loadCallSummaries = useCallback(async () => {
    const { data } = await supabase.from('call_summaries').select('*').order('created_at', { ascending: false })
    if (data) setCallSummaries(data)
  }, [])

  const loadLastSync = useCallback(async () => {
    const { data } = await supabase.from('settings').select('value').eq('key', 'last_sync_at').single()
    setLastSync(data?.value || null)
  }, [])

  useEffect(() => {
    loadTasks(); loadClients(); loadCallSummaries(); loadLastSync()
  }, [loadTasks, loadClients, loadCallSummaries, loadLastSync])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSync() {
    setSyncing(true); setSyncMsg(null)
    try {
      const res = await fetch('/api/sync-transcriptions', { method: 'POST' })
      const data = await res.json()
      setSyncMsg(data.error ? `❌ ${data.error}` : `✅ ${data.message}`)
      await Promise.all([loadTasks(), loadCallSummaries(), loadLastSync()])
    } catch { setSyncMsg('❌ Erro ao sincronizar.') }
    setSyncing(false)
  }

  async function submitCapture(text?: string, audioBlob?: Blob) {
    const msg = text ?? quickInput.trim()
    if (!msg && !audioBlob) return
    setCapturing(true)
    setQuickInput('')
    const fd = new FormData()
    if (audioBlob) fd.append('audio', audioBlob, 'audio.webm')
    if (msg) fd.append('text', msg)
    fd.append('history', JSON.stringify([]))
    try {
      const res = await fetch('/api/chat', { method: 'POST', body: fd })
      const data = await res.json()
      if (data.task) {
        await supabase.from('tasks').insert({
          title: data.task.title,
          description: data.task.description || null,
          priority: data.task.priority,
          deadline: data.task.deadline || null,
          category: data.task.category || 'trabalho',
          status: 'pendente',
          client_id: data.task.client_id || null,
        })
        await loadTasks()
      }
    } catch { /* silent */ }
    setCapturing(false)
  }

  async function toggleCaptureRecording() {
    if (captureRecording) { captureMediaRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      captureChunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) captureChunksRef.current.push(e.data) }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(captureChunksRef.current, { type: 'audio/webm' })
        if (blob.size > 0) submitCapture('', blob)
        setCaptureRecording(false)
      }
      captureMediaRef.current = recorder
      recorder.start()
      setCaptureRecording(true)
    } catch { alert('Permissão de microfone negada.'); setCaptureRecording(false) }
  }

  async function sendMessage(text?: string, audioBlob?: Blob) {
    const userText = (text ?? input).trim()
    if (!userText && !audioBlob) return

    const displayText = audioBlob ? '🎤 Enviando áudio…' : userText
    setMessages(prev => [...prev, { role: 'user', content: displayText }])
    setInput('')
    setLoading(true)

    const fd = new FormData()
    if (audioBlob) fd.append('audio', audioBlob, 'audio.webm')
    if (userText) fd.append('text', userText)
    fd.append('history', JSON.stringify(historyRef.current))

    try {
      const res = await fetch('/api/chat', { method: 'POST', body: fd })
      const data = await res.json()

      if (data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: '❌ ' + data.error }])
        setLoading(false)
        return
      }

      if (data.transcription) {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: `🎤 "${data.transcription}"` } : m
        ))
      }

      setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: data.transcription || userText },
        { role: 'assistant', content: data.message },
      ]

      if (data.task) {
        await supabase.from('tasks').insert({
          title: data.task.title,
          description: data.task.description || null,
          priority: data.task.priority,
          deadline: data.task.deadline || null,
          category: data.task.category || 'trabalho',
          status: 'pendente',
          client_id: data.task.client_id || null,
        })
        historyRef.current = []
        await loadTasks()
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Erro de conexão. Tente novamente.' }])
    }
    setLoading(false)
  }

  async function toggleRecording() {
    if (recording) { mediaRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (blob.size > 0) sendMessage('', blob)
        setRecording(false)
      }
      mediaRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch { alert('Permissão de microfone negada.'); setRecording(false) }
  }

  async function toggleTask(task: Task) {
    const next = task.status === 'concluida' ? 'pendente' : 'concluida'
    await supabase.from('tasks').update({ status: next }).eq('id', task.id)
    await loadTasks()
  }

  async function updateTask(id: string, updates: Partial<Task>) {
    await supabase.from('tasks').update(updates).eq('id', id)
    await loadTasks()
  }

  async function deleteTask(id: string) {
    await supabase.from('tasks').delete().eq('id', id)
    await loadTasks()
  }

  // Filter tasks
  const byCategory = taskTab === 'todas' ? tasks : tasks.filter(t => t.category === taskTab)
  const byClient = clientFilter ? byCategory.filter(t => t.client_id === clientFilter) : byCategory
  const pending = byClient.filter(t => t.status !== 'concluida')
  const done = byClient.filter(t => t.status === 'concluida')

  const tabCount = (k: TaskTab) => ({
    todas: tasks.filter(t => t.status !== 'concluida').length,
    trabalho: tasks.filter(t => t.category === 'trabalho' && t.status !== 'concluida').length,
    pessoal: tasks.filter(t => t.category === 'pessoal' && t.status !== 'concluida').length,
  }[k])

  const activeClients = clients.filter(c => c.status === 'active')
  const clientsWithTasks = activeClients.filter(c => tasks.some(t => t.client_id === c.id && t.status !== 'concluida'))

  // ── Tasks Panel ──
  const tasksPanel = (
    <div className="flex flex-col flex-1 overflow-hidden bg-[#F2F2F7]">
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Tarefas</h1>
            <p className="text-[13px] text-gray-400 mt-0.5">{pending.length} pendente{pending.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={handleSync} disabled={syncing}
            className={`mt-1 flex items-center gap-1.5 bg-gray-800 text-white text-[13px] font-medium px-3 py-1.5 rounded-full transition-opacity ${syncing ? 'opacity-60' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={syncing ? 'animate-spin' : ''}>
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {syncing ? 'Sincronizando…' : 'Reuniões'}
          </button>
        </div>

        {syncMsg && (
          <div className={`mt-2 text-[13px] px-3 py-2 rounded-xl ${syncMsg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {syncMsg}
          </div>
        )}
        {lastSync && (
          <p className="text-[11px] text-gray-300 mt-1">
            Último sync: {new Date(lastSync).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </p>
        )}

        {/* Quick capture bar */}
        <div className="mt-3 flex gap-2 bg-white rounded-2xl px-3 py-2 shadow-sm">
          <button onClick={toggleCaptureRecording}
            className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${captureRecording ? 'bg-red-500 animate-pulse' : 'bg-gray-100 text-gray-400'}`}
            title={captureRecording ? 'Parar gravação' : 'Gravar tarefa'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 2a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" stroke={captureRecording ? 'white' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M19 10a7 7 0 0 1-14 0" stroke={captureRecording ? 'white' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="12" y1="17" x2="12" y2="21" stroke={captureRecording ? 'white' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
          <input
            className="flex-1 text-[15px] outline-none bg-transparent placeholder:text-gray-300"
            placeholder={captureRecording ? 'Gravando…' : 'Nova tarefa… (Enter para criar)'}
            value={quickInput}
            onChange={e => setQuickInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !capturing && submitCapture()}
            disabled={capturing || captureRecording}
          />
          {capturing && (
            <span className="shrink-0 flex gap-1 items-center">
              {[0,120,240].map(d => (
                <span key={d} className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </span>
          )}
        </div>

        {/* Category tabs */}
        <div className="flex gap-2 mt-3">
          {(['todas','trabalho','pessoal'] as TaskTab[]).map(k => (
            <button key={k} onClick={() => setTaskTab(k)}
              className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all ${taskTab === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 shadow-sm'}`}>
              {k === 'todas' ? 'Todas' : k === 'trabalho' ? '💼' : '🏠'}
              <span className="ml-1.5 opacity-60">{tabCount(k)}</span>
            </button>
          ))}
        </div>

        {/* Client filter chips */}
        {clientsWithTasks.length > 0 && (
          <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1 scrollbar-hide">
            <button onClick={() => setClientFilter(null)}
              className={`shrink-0 px-3 py-1 rounded-full text-[12px] font-medium transition-all ${!clientFilter ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 shadow-sm'}`}>
              Todos
            </button>
            {clientsWithTasks.map(c => (
              <button key={c.id} onClick={() => setClientFilter(clientFilter === c.id ? null : c.id)}
                className={`shrink-0 px-3 py-1 rounded-full text-[12px] font-medium transition-all ${clientFilter === c.id ? 'bg-indigo-600 text-white' : 'bg-white text-indigo-600 shadow-sm'}`}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2 mt-2">
        {pending.length === 0 && done.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 pb-20">
            <span className="text-5xl mb-3">✅</span>
            <p className="text-[15px]">Nenhuma tarefa ainda</p>
            <p className="text-[13px] mt-1">Digite acima ou use o chat</p>
          </div>
        ) : (
          <>
            {pending.map(task => (
              <TaskCard key={task.id} task={task} clients={clients} onOpen={() => setEditingTask(task)} onToggle={() => toggleTask(task)} />
            ))}
            {done.length > 0 && (
              <>
                <button onClick={() => setShowDone(v => !v)}
                  className="flex items-center gap-2 text-[13px] text-gray-400 font-medium pt-2 pb-1 w-full">
                  <span className={`transition-transform ${showDone ? 'rotate-90' : ''}`}>›</span>
                  Concluídas ({done.length})
                </button>
                {showDone && done.map(task => (
                  <TaskCard key={task.id} task={task} clients={clients} onOpen={() => setEditingTask(task)} onToggle={() => toggleTask(task)} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )

  // ── Chat Panel ──
  const chatPanel = (
    <div className="flex flex-col flex-1 overflow-hidden bg-[#F2F2F7]">
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Chat</h1>
        <p className="text-[13px] text-gray-400 mt-0.5">Pergunte sobre clientes, calls ou tarefas</p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 space-y-2 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[82%] px-4 py-2.5 rounded-2xl text-[15px] leading-relaxed ${
              m.role === 'user' ? 'bg-blue-500 text-white rounded-br-md' : 'bg-white text-gray-800 rounded-bl-md shadow-sm'
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white px-4 py-3 rounded-2xl rounded-bl-md shadow-sm">
              <span className="flex gap-1.5">
                {[0,160,320].map(d => (
                  <span key={d} className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="px-3 py-2 bg-[#F2F2F7]">
        <div className="flex gap-2 items-end bg-white rounded-2xl px-3 py-2 shadow-sm">
          <button onClick={toggleRecording}
            className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${recording ? 'bg-red-500 animate-pulse' : 'bg-gray-100 text-gray-500'}`}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 2a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" stroke={recording ? 'white' : 'currentColor'} strokeWidth="2" strokeLinecap="round"/>
              <path d="M19 10a7 7 0 0 1-14 0" stroke={recording ? 'white' : 'currentColor'} strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="17" x2="12" y2="21" stroke={recording ? 'white' : 'currentColor'} strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          <input className="flex-1 text-[15px] outline-none bg-transparent py-1 placeholder:text-gray-300"
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && sendMessage()}
            placeholder={recording ? 'Gravando…' : 'Mensagem'}
            disabled={loading || recording} />
          <button onClick={() => !loading && sendMessage()} disabled={loading || !input.trim() || recording}
            className="shrink-0 w-9 h-9 rounded-full bg-blue-500 flex items-center justify-center disabled:opacity-30">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M14 8L2 2L5.5 8L2 14L14 8Z" fill="white"/>
            </svg>
          </button>
        </div>
        {recording && <p className="text-center text-[12px] text-red-500 mt-1.5 animate-pulse">● Gravando · Toque no mic para enviar</p>}
      </div>
    </div>
  )

  // ── SVG icons for tab bar ──
  const tabIcons = {
    tasks: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="5" width="18" height="2" rx="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
        <rect x="3" y="11" width="14" height="2" rx="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
        <rect x="3" y="17" width="10" height="2" rx="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
        <path d="M17 14l2 2 4-4" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    daily: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="4" width="18" height="17" rx="2" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8"/>
        <path d="M16 2v4M8 2v4" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M3 9h18" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8"/>
        <circle cx="8" cy="14" r="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
        <circle cx="12" cy="14" r="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
        <circle cx="16" cy="14" r="1" fill={active ? '#3B82F6' : '#9CA3AF'}/>
      </svg>
    ),
    calls: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 2a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M19 10a7 7 0 0 1-14 0" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round"/>
        <line x1="12" y1="17" x2="12" y2="21" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round"/>
        <line x1="9" y1="21" x2="15" y2="21" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    ),
    chat: (active: boolean) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke={active ? '#3B82F6' : '#9CA3AF'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  }

  const pendingAllTasks = tasks.filter(t => t.status !== 'concluida').length

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif', background: '#F2F2F7' }}>

      {/* ── Desktop: tasks left + secondary panel right ── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-200/70">
          {tasksPanel}
        </div>
        <div className="w-[400px] flex flex-col overflow-hidden">
          {/* Right panel tab bar */}
          <div className="flex border-b border-gray-200/70 bg-white shrink-0">
            {(['daily', 'calls', 'chat'] as const).map(tab => (
              <button key={tab} onClick={() => setRightTab(tab)}
                className={`flex-1 py-3 text-[13px] font-medium transition-colors ${rightTab === tab ? 'text-blue-500 border-b-2 border-blue-500' : 'text-gray-400'}`}>
                {tab === 'daily' ? 'Daily' : tab === 'calls' ? 'Calls' : 'Chat'}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-hidden flex flex-col">
            {rightTab === 'daily' && <DailyView />}
            {rightTab === 'calls' && <CallsView summaries={callSummaries} />}
            {rightTab === 'chat' && chatPanel}
          </div>
        </div>
      </div>

      {/* ── Mobile: full-screen + bottom tab bar ── */}
      <div className="md:hidden flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden flex flex-col">
          {activeTab === 'tasks' && tasksPanel}
          {activeTab === 'daily' && <DailyView />}
          {activeTab === 'calls' && <CallsView summaries={callSummaries} />}
          {activeTab === 'chat' && chatPanel}
        </div>

        <nav className="shrink-0 bg-white/90 backdrop-blur-md border-t border-gray-200/60 flex"
          style={{ height: '88px', paddingBottom: 'max(env(safe-area-inset-bottom), 20px)' }}>
          {([
            ['tasks', 'Tarefas'],
            ['daily', 'Daily'],
            ['calls', 'Calls'],
            ['chat', 'Chat'],
          ] as [ActiveTab, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 pt-2 transition-colors ${activeTab === key ? 'text-blue-500' : 'text-gray-400'}`}>
              {tabIcons[key](activeTab === key)}
              <span className="text-[10px] font-medium tracking-wide">{label}</span>
              {key === 'tasks' && pendingAllTasks > 0 && (
                <span className="absolute top-2 right-[calc(50%-14px)] bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                  {pendingAllTasks > 9 ? '9+' : pendingAllTasks}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {editingTask && (
        <TaskSheet
          task={editingTask}
          clients={clients}
          onClose={() => setEditingTask(null)}
          onSave={async u => { await updateTask(editingTask.id, u) }}
          onDelete={() => { deleteTask(editingTask.id); setEditingTask(null) }}
        />
      )}
    </div>
  )
}
