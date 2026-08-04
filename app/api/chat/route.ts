import Groq from 'groq-sdk'
import { NextRequest, NextResponse } from 'next/server'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

function getSystemPrompt() {
  const today = new Date()
  const todayISO = today.toISOString().split('T')[0]
  const todayBR = today.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })

  return `Você é um assistente de gestão de tarefas para Ivan Felipe (marketing de performance — SEO, tráfego pago, funis, ads).
Hoje é ${todayBR} (ISO: ${todayISO}).

FLUXO OBRIGATÓRIO ao criar uma tarefa (colete UM dado por vez, nunca pergunte tudo de uma vez):
1. Usuário descreve a tarefa
2. Se a tarefa parece PROFISSIONAL e não mencionou cliente/empresa → pergunte: "Para qual cliente é essa tarefa?"
3. Se não informou prazo → pergunte o prazo
4. Se não informou prioridade → pergunte a prioridade e inclua exatamente ao final da mensagem: [AWAITING_PRIORITY]
5. Quando tiver todos os dados → responda APENAS com JSON (sem texto extra):

{"action":"create_task","title":"[Cliente] Ação objetiva","description":"Detalhes relevantes","priority":"alta|media|baixa","deadline":"YYYY-MM-DD ou null","category":"trabalho|pessoal"}

REGRAS:
- title: para trabalho, sempre "[\${Cliente}] \${ação}"
- priority: exatamente "alta", "media" ou "baixa" (sem acento em media)
- deadline: "hoje" = ${todayISO}, "amanhã" = próximo dia, "semana que vem" = +7 dias
- Se a tarefa for claramente pessoal (saúde, família, lazer), pule a pergunta de cliente
- Se o usuário já informou tudo na primeira mensagem, pule as perguntas e crie direto
- Fora do fluxo de tarefas, responda normalmente em português, de forma direta`
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const text = formData.get('text') as string | null
    const audio = formData.get('audio') as File | null
    const historyRaw = formData.get('history') as string

    const history: Array<{ role: 'user' | 'assistant'; content: string }> =
      historyRaw ? JSON.parse(historyRaw) : []

    let userMessage = text?.trim() || ''

    if (audio && audio.size > 0) {
      const transcription = await groq.audio.transcriptions.create({
        file: audio,
        model: 'whisper-large-v3',
        language: 'pt',
        response_format: 'text',
      })
      userMessage = (transcription as unknown as string).trim()
    }

    if (!userMessage) {
      return NextResponse.json({ error: 'Nenhuma mensagem recebida' }, { status: 400 })
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.5,
      max_tokens: 600,
      messages: [
        { role: 'system', content: getSystemPrompt() },
        ...history,
        { role: 'user', content: userMessage },
      ],
    })

    let responseText = completion.choices[0].message.content || ''

    // Detecta se está pedindo prioridade via marker
    const awaitingPriority = responseText.includes('[AWAITING_PRIORITY]')
    responseText = responseText.replace('[AWAITING_PRIORITY]', '').trim()

    // Detecta JSON de criação de tarefa
    let task = null
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*"action"\s*:\s*"create_task"[\s\S]*\}/)
      if (jsonMatch) task = JSON.parse(jsonMatch[0])
    } catch { /* resposta normal */ }

    return NextResponse.json({
      message: task ? `✅ Tarefa "${task.title}" criada!` : responseText,
      transcription: audio && audio.size > 0 ? userMessage : null,
      awaitingPriority: task ? false : awaitingPriority,
      task,
    })
  } catch (err) {
    console.error('Erro na API de chat:', err)
    return NextResponse.json({ error: 'Erro interno. Tente novamente.' }, { status: 500 })
  }
}
