import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Conversation, Project } from '@shared/types'

/** 프로젝트·대화 목록을 userData/projects.json에 저장. 카드 순서 = 배열 순서 (숫자키 고정). */
export class ProjectStore {
  private readonly file = join(app.getPath('userData'), 'projects.json')
  private projects: Project[] = []

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.projects = JSON.parse(readFileSync(this.file, 'utf8')) as Project[]
      } catch (err) {
        console.error('projects.json 읽기 실패, 빈 목록으로 시작', err)
      }
    }
  }

  list(): Project[] {
    return structuredClone(this.projects)
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((p) => p.id === projectId)
  }

  getConversation(projectId: string, conversationId: string): Conversation | undefined {
    return this.get(projectId)?.conversations.find((c) => c.id === conversationId)
  }

  addProject(path: string): Project {
    const project: Project = {
      id: randomUUID(),
      name: basename(path) || path,
      path,
      conversations: [newConversation(1)],
    }
    this.projects.push(project)
    this.save()
    return project
  }

  removeProject(projectId: string): void {
    this.projects = this.projects.filter((p) => p.id !== projectId)
    this.save()
  }

  addConversation(projectId: string): Conversation {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const conv = newConversation(project.conversations.length + 1)
    project.conversations.push(conv)
    this.save()
    return conv
  }

  /** 대화를 지우고 옮겨 갈 대화 ID를 돌려준다 (바로 다음 것, 없으면 앞의 것). 마지막 대화였다면 빈 대화를 만든다 */
  removeConversation(projectId: string, conversationId: string): string {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const i = project.conversations.findIndex((c) => c.id === conversationId)
    if (i >= 0) project.conversations.splice(i, 1)
    if (project.conversations.length === 0) project.conversations.push(newConversation(1))
    this.save()
    return (project.conversations[i] ?? project.conversations[i - 1] ?? project.conversations[0]).id
  }

  /** 작업 하나 = 대화 하나. 한 번도 보내지 않은 대화(isFresh)가 있으면 재사용하고 제목을 작업 문장으로 바꾼다 */
  conversationForTask(projectId: string, text: string, isFresh: (conv: Conversation) => boolean): Conversation {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const title = text.length > 40 ? `${text.slice(0, 40)}…` : text
    const reusable = project.conversations.find((c) => !c.sessionId && isFresh(c))
    const conv = reusable ?? newConversation(project.conversations.length + 1)
    if (!reusable) project.conversations.push(conv)
    conv.title = title
    this.save()
    return conv
  }

  updateConversation(projectId: string, conversationId: string, patch: Partial<Conversation>): void {
    const conv = this.getConversation(projectId, conversationId)
    if (!conv) return
    Object.assign(conv, patch)
    this.save()
  }

  private save(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.projects, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

function newConversation(n: number): Conversation {
  return { id: randomUUID(), title: `대화 ${n}`, mode: 'default' }
}
