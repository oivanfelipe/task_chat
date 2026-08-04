'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase, type Task } from '@/lib/supabase'

type Message = { role: 'user' | 'assistant'; content: string }
type HistoryItem = { role: 'user' | 'assistant'; content: string }
type ActiveTab = 'chat' | 'tasks'
type TaskTab = 'todas' | 'trabalho' | 'pessoal'

// ─── Helpers ──────────────────────────────────────────────────
const P = {
  alta:  { label: 'Alta',  dot: '#EF4444', dark: '#DC2626', btnCls: 'bg-red-500 text-white',    ringCls: 'ring-red-300' },
  media: { label: 'Média', dot: '#F97316', dark: '#EA580C', btnCls: 'bg-orange-500 text-white', ringCls: 'ring-orange-300' },
  baixa: { label: 'Baixa', dot: '#22C55E', dark: '#16A34A', btnCls: 'bg-green-500 text-white',  ringCls: 'ring-green-300' },
} as const

function urgencyScore(t: Task) {
  const s = { alta: 3, media: 2, baixa: 1 }[t.priority] ?? 1
  if (!t.deadline) return s * 10
  const today = new Date(); today.setHours(0,0,0,0)
  const due = new Date(t.deadline + 'T00:00:00')
  const d = Math.ceil((due.getTime() - today.getTime()) / 86400000)
  return s * 10 + (d <= 0 ? 1000 : d <= 1 ? 500 : d <= 3 ? 200 : d <= 7 ? 100 : 50)
}

function deadlineLabel(deadline: string | null) {
  if (!deadline) return null
  const today = new Date(); today.setHours(0,0,0,0)
  const due = new Date(deadline + 'T00:00:00')
  const d = Math.ceil((due.getTime() - today.getTime()) / 86400000)
  const s = due.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  if (d < 0) return { text: `Atrasada · ${s}`, cls: 'text-red-500' }
  if (d === 0) return { text: 'Hoje', cls: 'text-orange-500' }
  if (d === 1) return { text: 'Amanhã', cls: 'text-orange-400' }
  if (d <= 7) return { text: `${d}d · ${s}`, cls: 'text-yellow-600' }
  return { text: s, cls: 'text-gray-400' }
}

// ─── TaskCard ─────────────────────────────────────────────────
function TaskCard({ task, onOpen, onToggle }: {
  task: Task; onOpen: () => void; onToggle: () => void
}) {
  const p = P[task.priority]
  const dl = deadlineLabel(task.deadline)
  const done = task.status === 'concluida'

  return (
    <div className={`bg-white rounded-2xl flex items-start gap-3 px-4 py-3.5 transition-opacity ${done ? 'opacity-40' : ''}`}>
      {/* Check circle */}
      <button onClick={onToggle} className="mt-0.5 shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all"
        style={{ borderColor: done ? '#3B82F6' : '#D1D5DB', background: done ? '#3B82F6' : 'transparent' }}>
        {done && (
          <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
            <path d="M1 3.8L4 6.8L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen}>
        <p className={`text-[15px] font-medium text-gray-900 leading-snug ${done ? 'line-through' : ''}`}>{task.title}</p>
        {task.description && !done && (
          <p className="text-sm text-gray-400 mt-0.5 line-clamp-1">{task.description}</p>
        )}
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.dot }} />
            <span className="text-xs font-medium" style={{ color: p.dark }}>{p.label}</span>
          </span>
          {dl && <span className={`text-xs ${dl.cls}`}>· {dl.text}</span>}
          <span className="text-xs text-gray-300">·</span>
          <span className="text-xs">{task.category === 'trabalho' ? '💼' : '🏠'}</span>
        </div>
      </div>

      {/* Chevron */}
      <button onClick={onOpen} className="mt-1.5 shrink-0 text-gray-300">
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M1 1L6 6L1 11" stroke="#C7C7CC" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}

// ─── TaskSheet ────────────────────────────────────────────────
function TaskSheet({ task, onClose, onSave, onDelete }: {
  task: Task
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
  const [aiQ, setAiQ] = useState('')
  const [aiA, setAiA] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSave({ title, description: description || null, priority, deadline: deadline || null, category, notes: notes || null })
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
        { role: 'user', content: `Contexto da tarefa:\nTítulo: "${task.title}"\nDescrição: "${task.description || ''}"\nPrioridade: ${task.priority}\nCategoria: ${task.category}\nPrazo: ${task.deadline || 'sem prazo'}\nNotas: ${task.notes || ''}` },
        { role: 'assistant', content: 'Entendido. Posso responder perguntas sobre essa tarefa ou sugerir próximos passos.' },
      ]))
      const res = await fetch('/api/chat', { method: 'POST', body: fd })
      const data = await res.json()
      setAiA(data.message || 'Sem resposta.')
    } catch { setAiA('Erro ao consultar.') }
    setAiLoading(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-[#F2F2F7] rounded-t-[28px] max-h-[92vh] overflow-y-auto">
        {/* Handle + Header */}
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
          {/* Título + Descrição */}
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

          {/* Prioridade */}
          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2.5">Prioridade</label>
            <div className="flex gap-2">
              {(['alta','media','baixa'] as const).map(v => (
                <button key={v} onClick={() => setPriority(v)}
                  className={`flex-1 py-2.5 rounded-xl text-[14px] font-semibold transition-all ring-0 ${priority === v ? P[v].btnCls + ' ring-2 ' + P[v].ringCls : 'bg-gray-100 text-gray-500'}`}>
                  {P[v].label}
                </button>
              ))}
            </div>
          </section>

          {/* Prazo + Categoria */}
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

          {/* Notas */}
          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-1">Notas</label>
            <textarea
              className="w-full text-[15px] mt-1 outline-none bg-transparent resize-none min-h-[80px] text-gray-700 placeholder:text-gray-300"
              placeholder="Links, observações, referências…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </section>

          {/* IA sobre esta tarefa */}
          <section className="bg-white rounded-2xl px-4 py-3">
            <label className="text-[11px] text-gray-400 uppercase tracking-wider block mb-2">Perguntar à IA</label>
            <div className="flex gap-2">
              <input
                className="flex-1 text-[15px] bg-gray-50 rounded-xl px-3 py-2 outline-none placeholder:text-gray-300"
                placeholder="Ex: Quais próximos passos?"
                value={aiQ}
                onChange={e => setAiQ(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && askAI()}
              />
              <button onClick={askAI} disabled={aiLoading || !aiQ.trim()}
                className="bg-blue-500 text-white text-[14px] font-semibold px-4 py-2 rounded-xl disabled:opacity-40 whitespace-nowrap">
                {aiLoading ? '…' : 'Enviar'}
              </button>
            </div>
            {aiA && (
              <div className="mt-3 bg-blue-50 rounded-xl p-3 text-[14px] text-gray-700 leading-relaxed">{aiA}</div>
            )}
          </section>

          {/* Excluir */}
          <button onClick={() => { onDelete(); onClose() }}
            className="w-full bg-white rounded-2xl py-4 text-red-500 text-[15px] font-medium active:opacity-70">
            Excluir Tarefa
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Home ─────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')
  const [taskTab, setTaskTab] = useState<TaskTab>('todas')
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Olá Ivan! Me diga o que precisa fazer — pode digitar ou gravar um áudio.' },
  ])
  const [input, setInput] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [awaitingPriority, setAwaitingPriority] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [showDone, setShowDone] = useState(false)

  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HistoryItem[]>([])

  const loadTasks = useCallback(async () => {
    const { data } = await supabase.from('tasks').select('*')
    if (data) setTasks([...data].sort((a, b) => urgencyScore(b) - urgencyScore(a)))
  }, [])

  const loadLastSync = useCallback(async () => {
    const { data } = await supabase.from('settings').select('value').eq('key', 'last_sync_at').single()
    setLastSync(data?.value || null)
  }, [])

  useEffect(() => { loadTasks(); loadLastSync() }, [loadTasks, loadLastSync])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSync() {
    setSyncing(true); setSyncMsg(null)
    try {
      const res = await fetch('/api/sync-transcriptions', { method: 'POST' })
      const data = await res.json()
      setSyncMsg(data.error ? `❌ ${data.error}` : `✅ ${data.message}`)
      await loadTasks(); await loadLastSync()
    } catch { setSyncMsg('❌ Erro ao sincronizar.') }
    setSyncing(false)
  }

  async function sendMessage(text?: string, audioBlob?: Blob, priorityChoice?: string) {
    const userText = priorityChoice
      ? `Prioridade: ${priorityChoice}`
      : (text ?? input).trim()

    if (!userText && !audioBlob) return

    const displayText = priorityChoice
      ? `Prioridade ${P[priorityChoice as keyof typeof P]?.label ?? priorityChoice}`
      : audioBlob ? '🎤 Enviando áudio…' : userText

    setMessages(prev => [...prev, { role: 'user', content: displayText }])
    setInput('')
    setAwaitingPriority(false)
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

      const content = data.message
      setMessages(prev => [...prev, { role: 'assistant', content }])
      setAwaitingPriority(!!data.awaitingPriority)

      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: data.transcription || userText },
        { role: 'assistant', content },
      ]

      if (data.task) {
        const { error: insertError } = await supabase.from('tasks').insert({
          title: data.task.title,
          description: data.task.description || null,
          priority: data.task.priority,
          deadline: data.task.deadline || null,
          category: data.task.category || 'trabalho',
          status: 'pendente',
        })
        if (insertError) {
          setMessages(prev => [...prev, { role: 'assistant', content: `❌ Erro ao salvar tarefa: ${insertError.message}` }])
          setLoading(false)
          return
        }
        historyRef.current = []
        setAwaitingPriority(false)
        await loadTasks()
        // Muda para aba de tarefas no mobile após criar
        setTimeout(() => setActiveTab('tasks'), 600)
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

  // Filtered lists
  const byTab = taskTab === 'todas' ? tasks : tasks.filter(t => t.category === taskTab)
  const pending = byTab.filter(t => t.status !== 'concluida')
  const done = byTab.filter(t => t.status === 'concluida')
  const tabCount = (k: TaskTab) => ({
    todas: tasks.filter(t => t.status !== 'concluida').length,
    trabalho: tasks.filter(t => t.category === 'trabalho' && t.status !== 'concluida').length,
    pessoal: tasks.filter(t => t.category === 'pessoal' && t.status !== 'concluida').length,
  }[k])

  // ── Chat Panel ──
  const chatPanel = (
    <div className="flex flex-col flex-1 overflow-hidden bg-[#F2F2F7]">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 bg-[#F2F2F7]">
        <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Chat</h1>
        <p className="text-[13px] text-gray-400 mt-0.5">Descreva uma tarefa por voz ou texto</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 space-y-2 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[82%] px-4 py-2.5 rounded-2xl text-[15px] leading-relaxed ${
              m.role === 'user'
                ? 'bg-blue-500 text-white rounded-br-md'
                : 'bg-white text-gray-800 rounded-bl-md shadow-sm'
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
        {/* Priority picker */}
        {awaitingPriority && !loading && (
          <div className="flex justify-start">
            <div className="flex gap-2 mt-1">
              {(['alta','media','baixa'] as const).map(p => (
                <button key={p} onClick={() => sendMessage(undefined, undefined, p)}
                  className={`px-4 py-2 rounded-full text-[14px] font-semibold text-white shadow-sm active:scale-95 transition-transform ${P[p].btnCls}`}>
                  {P[p].label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input bar */}
      <div className="px-3 py-2 bg-[#F2F2F7]">
        <div className="flex gap-2 items-end bg-white rounded-2xl px-3 py-2 shadow-sm">
          <button onClick={toggleRecording}
            className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-lg transition-all ${
              recording ? 'bg-red-500 text-white animate-pulse' : 'bg-gray-100 text-gray-500'
            }`}
            title={recording ? 'Toque para parar' : 'Toque para gravar'}>
            🎤
          </button>
          <input
            className="flex-1 text-[15px] outline-none bg-transparent py-1 placeholder:text-gray-300"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && sendMessage()}
            placeholder={recording ? 'Gravando…' : 'Mensagem'}
            disabled={loading || recording}
          />
          <button onClick={() => !loading && sendMessage()} disabled={loading || !input.trim() || recording}
            className="shrink-0 w-9 h-9 rounded-full bg-blue-500 flex items-center justify-center disabled:opacity-30 transition-opacity">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M14 8L2 2L5.5 8L2 14L14 8Z" fill="white"/>
            </svg>
          </button>
        </div>
        {recording && (
          <p className="text-center text-[12px] text-red-500 mt-1.5 animate-pulse">● Gravando · Toque em 🎤 para enviar</p>
        )}
      </div>
    </div>
  )

  // ── Tasks Panel ──
  const tasksPanel = (
    <div className="flex flex-col flex-1 overflow-hidden bg-[#F2F2F7]">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 bg-[#F2F2F7]">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[28px] font-bold text-gray-900 tracking-tight">Tarefas</h1>
            <p className="text-[13px] text-gray-400 mt-0.5">{pending.length} pendente{pending.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={handleSync} disabled={syncing}
            className={`mt-1 flex items-center gap-1.5 bg-gray-800 text-white text-[13px] font-medium px-3 py-1.5 rounded-full transition-opacity ${syncing ? 'opacity-60' : ''}`}>
            <span className={syncing ? 'animate-spin' : ''}>🔄</span>
            {syncing ? 'Sincronizando…' : 'Reuniões'}
          </button>
        </div>

        {/* Sync message */}
        {syncMsg && (
          <div className={`mt-2 text-[13px] px-3 py-2 rounded-xl ${syncMsg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
            {syncMsg}
          </div>
        )}

        {lastSync && (
          <p className="text-[11px] text-gray-300 mt-1">
            Último sync: {new Date(lastSync).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}
          </p>
        )}

        {/* Category tabs */}
        <div className="flex gap-2 mt-3">
          {(['todas','trabalho','pessoal'] as TaskTab[]).map(k => (
            <button key={k} onClick={() => setTaskTab(k)}
              className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all ${
                taskTab === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 shadow-sm'
              }`}>
              {k === 'todas' ? 'Todas' : k === 'trabalho' ? '💼 Trabalho' : '🏠 Pessoal'}
              <span className="ml-1.5 opacity-60">{tabCount(k)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2 mt-2">
        {pending.length === 0 && done.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 pb-20">
            <span className="text-5xl mb-3">✅</span>
            <p className="text-[15px]">Nenhuma tarefa ainda</p>
            <p className="text-[13px] mt-1">Use o chat para adicionar</p>
          </div>
        ) : (
          <>
            {pending.map(task => (
              <TaskCard key={task.id} task={task} onOpen={() => setEditingTask(task)} onToggle={() => toggleTask(task)} />
            ))}

            {done.length > 0 && (
              <>
                <button onClick={() => setShowDone(v => !v)}
                  className="flex items-center gap-2 text-[13px] text-gray-400 font-medium pt-2 pb-1 w-full">
                  <span className={`transition-transform ${showDone ? 'rotate-90' : ''}`}>›</span>
                  Concluídas ({done.length})
                </button>
                {showDone && done.map(task => (
                  <TaskCard key={task.id} task={task} onOpen={() => setEditingTask(task)} onToggle={() => toggleTask(task)} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif', background: '#F2F2F7' }}>

      {/* ── Desktop: side-by-side ── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="w-[400px] flex flex-col border-r border-gray-200/70 overflow-hidden">
          {chatPanel}
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          {tasksPanel}
        </div>
      </div>

      {/* ── Mobile: tab switcher ── */}
      <div className="md:hidden flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {activeTab === 'chat' ? chatPanel : tasksPanel}
        </div>

        {/* iOS Tab Bar */}
        <nav className="shrink-0 bg-white/80 backdrop-blur-md border-t border-gray-200/60 flex"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
          {([
            ['chat',  'Chat',    '💬'],
            ['tasks', 'Tarefas', '✅'],
          ] as [ActiveTab, string, string][]).map(([key, label, icon]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`flex-1 flex flex-col items-center pt-2 pb-1 gap-0.5 transition-colors ${activeTab === key ? 'text-blue-500' : 'text-gray-400'}`}>
              <span className="text-[22px] leading-none">{icon}</span>
              <span className="text-[10px] font-medium tracking-wide">{label}</span>
              {key === 'tasks' && pending.length > 0 && (
                <span className="absolute mt-0 ml-5 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center -translate-y-1">
                  {pending.length > 9 ? '9+' : pending.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Task Detail Sheet */}
      {editingTask && (
        <TaskSheet
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={async u => { await updateTask(editingTask.id, u) }}
          onDelete={() => { deleteTask(editingTask.id); setEditingTask(null) }}
        />
      )}
    </div>
  )
}
