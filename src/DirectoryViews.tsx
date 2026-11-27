import { invoke } from '@tauri-apps/api/core';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { projectColour } from './miniTimerModel';
import { sameId as same } from './shellModel';

type Id = number | string;
type Client = { id: Id; name: string; archived: boolean };
type Project = { id: Id; client_id: Id; name: string; archived: boolean; billable: boolean };
type Task = { id: Id; project_id: Id; name: string; archived: boolean };

type Props = {
  mode: 'clients' | 'projects';
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  clientLabelById: Map<string, string>;
  loaded: boolean;
  busy: boolean;
  selectedClientId: string;
  selectedProjectId: string;
  onSelectTarget: (clientId: string, projectId: string, taskId: string) => void;
  onRunCommand: (action: () => Promise<unknown>, successMessage: string) => Promise<void>;
  onOpenTimer: () => void;
};

export default function DirectoryViews({
  mode,
  clients,
  projects,
  tasks,
  clientLabelById,
  loaded,
  busy,
  selectedClientId,
  selectedProjectId,
  onSelectTarget,
  onRunCommand,
  onOpenTimer,
}: Props) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newProjectClientId, setNewProjectClientId] = useState(selectedClientId);
  const [newProjectName, setNewProjectName] = useState('');
  const [newTaskProjectId, setNewTaskProjectId] = useState(selectedProjectId);
  const [newTaskName, setNewTaskName] = useState('');
  const [editing, setEditing] = useState<{ kind: 'client' | 'project' | 'task'; id: Id; expected: string; value: string } | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const activeClients = useMemo(() => clients.filter(item => !item.archived), [clients]);
  const activeProjects = useMemo(() => projects.filter(item => {
    const owner = clients.find(client => same(client.id, item.client_id));
    return !item.archived && owner && !owner.archived;
  }), [clients, projects]);

  const effectiveProjectClientId = newProjectClientId && activeClients.some(item => same(item.id, newProjectClientId))
    ? newProjectClientId
    : (selectedClientId && activeClients.some(item => same(item.id, selectedClientId))
      ? selectedClientId
      : (activeClients[0] ? String(activeClients[0].id) : ''));

  const effectiveTaskProjectId = newTaskProjectId && activeProjects.some(item => same(item.id, newTaskProjectId))
    ? newTaskProjectId
    : (selectedProjectId && activeProjects.some(item => same(item.id, selectedProjectId))
      ? selectedProjectId
      : (activeProjects[0] ? String(activeProjects[0].id) : ''));

  const visibleClients = useMemo(() => clients.filter(client => {
    if (!showArchived && client.archived) return false;
    if (!normalizedQuery) return true;
    const label = clientLabelById.get(String(client.id)) ?? client.name;
    return label.toLowerCase().includes(normalizedQuery);
  }), [clients, showArchived, normalizedQuery, clientLabelById]);

  const visibleProjects = useMemo(() => projects.filter(project => {
    const owner = clients.find(client => same(client.id, project.client_id));
    const effectivelyArchived = project.archived || Boolean(owner?.archived);
    if (!showArchived && effectivelyArchived) return false;
    if (!normalizedQuery) return true;
    const ownerLabel = owner ? (clientLabelById.get(String(owner.id)) ?? owner.name) : '';
    const projectTasks = tasks.filter(task => same(task.project_id, project.id));
    return (
      project.name.toLowerCase().includes(normalizedQuery)
      || ownerLabel.toLowerCase().includes(normalizedQuery)
      || projectTasks.some(task => task.name.toLowerCase().includes(normalizedQuery))
    );
  }), [projects, clients, tasks, showArchived, normalizedQuery, clientLabelById]);

  function handleCreateClient(event: FormEvent) {
    event.preventDefault();
    const name = newClientName.trim();
    if (!name) return;
    void onRunCommand(async () => {
      const id = String(await invoke<number>('create_client', { name }));
      setNewClientName('');
      setNewProjectClientId(id);
      onSelectTarget(id, '', '');
    }, 'Klient dodany.');
  }

  function handleCreateProject(event: FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || !effectiveProjectClientId) return;
    void onRunCommand(async () => {
      const id = String(await invoke<number>('create_project', { clientId: Number(effectiveProjectClientId), name }));
      setNewProjectName('');
      setNewTaskProjectId(id);
      onSelectTarget(effectiveProjectClientId, id, '');
    }, 'Projekt dodany.');
  }

  function handleCreateTask(event: FormEvent) {
    event.preventDefault();
    const name = newTaskName.trim();
    const project = projects.find(item => same(item.id, effectiveTaskProjectId));
    if (!name || !project) return;
    void onRunCommand(async () => {
      const id = String(await invoke<number>('create_task', { projectId: Number(project.id), name }));
      setNewTaskName('');
      onSelectTarget(String(project.client_id), String(project.id), id);
    }, 'Zadanie dodane.');
  }

  function handleRenameSubmit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !editing.value.trim()) return;
    const target = editing;
    void onRunCommand(async () => {
      await invoke('rename_item', {
        kind: target.kind,
        id: Number(target.id),
        expectedName: target.expected,
        name: target.value,
      });
      setEditing(null);
    }, 'Nazwa została zmieniona.');
  }

  const controls = (
    <div className="directory-toolbar">
      <label className="directory-search">
        Szukaj {mode === 'clients' ? 'klienta' : 'projektu lub zadania'}
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={mode === 'clients' ? 'Filtruj klientów...' : 'Filtruj projekty, klientów lub zadania...'}
        />
      </label>
      <label className="directory-archived-toggle">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
        Pokaż zarchiwizowane
      </label>
    </div>
  );

  const renameBox = editing && (
    <form
      className="card directory-rename-card"
      aria-label="Zmiana nazwy"
      onSubmit={handleRenameSubmit}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }}
    >
      <div className="section-top">
        <div>
          <p className="section-kicker">EDYCJA NAZWY</p>
          <h2>Nowa nazwa dla: {editing.expected}</h2>
        </div>
      </div>
      <div className="directory-rename-row">
        <label>
          Nazwa
          <input
            autoFocus
            value={editing.value}
            maxLength={200}
            onChange={e => setEditing({ ...editing, value: e.target.value })}
          />
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !loaded || !editing.value.trim()}>Zapisz nazwę</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Anuluj</button>
        </div>
      </div>
    </form>
  );

  if (mode === 'clients') {
    return (
      <section className="directory-view" aria-label="Katalog klientów">
        <section className="card">
          <div className="section-top">
            <div>
              <p className="section-kicker">NOWY KLIENT</p>
              <h2>Dodaj klienta</h2>
            </div>
          </div>
          <form className="directory-create-form" onSubmit={handleCreateClient}>
            <label>
              Nazwa klienta
              <input
                value={newClientName}
                disabled={busy || !loaded}
                maxLength={200}
                onChange={e => setNewClientName(e.target.value)}
                placeholder="np. Klient Studio"
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !loaded || !newClientName.trim()}>Dodaj klienta</button>
          </form>
        </section>

        {renameBox}

        <section className="card">
          <div className="section-top">
            <div>
              <p className="section-kicker">REJESTR</p>
              <h2>Lista klientów</h2>
            </div>
            <span className="count">{visibleClients.length} z {clients.length}</span>
          </div>
          {controls}
          {!loaded ? (
            <p className="muted">Lista klientów jest niedostępna do czasu ponownego odczytu danych.</p>
          ) : visibleClients.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">◈</div>
              <strong>{clients.length === 0 ? 'Brak klientów' : 'Brak pasujących klientów'}</strong>
              <p>{clients.length === 0 ? 'Dodaj pierwszego klienta powyżej, aby tworzyć projekty.' : 'Zmień frazę wyszukiwania lub pokaż zarchiwizowane pozycje.'}</p>
            </div>
          ) : (
            <ul className="directory-list">
              {visibleClients.map(client => {
                const clientProjects = projects.filter(project => same(project.client_id, client.id));
                const activeCount = clientProjects.filter(project => !project.archived).length;
                const label = clientLabelById.get(String(client.id)) ?? client.name;
                return (
                  <li key={client.id} className="directory-row" data-archived={client.archived || undefined}>
                    <div className="directory-row-main">
                      <strong>{label}{client.archived ? ' (archiwum)' : ''}</strong>
                      <small className="muted">
                        Projekty: {clientProjects.length} ({activeCount} aktywnych)
                      </small>
                      {clientProjects.length > 0 && (
                        <div className="directory-pill-row">
                          {clientProjects.slice(0, 6).map(project => (
                            <span key={project.id} className="directory-project-chip">
                              <span className="qp-dot" data-project-colour={projectColour(project.id)} aria-hidden="true" />
                              {project.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="actions directory-row-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !loaded || client.archived}
                        onClick={() => {
                          const firstProject = clientProjects.find(project => !project.archived);
                          onSelectTarget(String(client.id), firstProject ? String(firstProject.id) : '', '');
                          onOpenTimer();
                        }}
                      >
                        Ustaw w timerze
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !loaded}
                        onClick={() => setEditing({ kind: 'client', id: client.id, expected: client.name, value: client.name })}
                      >
                        Zmień nazwę
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !loaded}
                        onClick={() => void onRunCommand(
                          () => invoke('archive_client', { clientId: Number(client.id), archived: !client.archived }),
                          client.archived ? 'Klient przywrócony. Projekty pozostają w archiwum.' : 'Klient przeniesiony do archiwum; historia pozostaje dostępna.',
                        )}
                      >
                        {client.archived ? 'Przywróć' : 'Archiwizuj'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </section>
    );
  }

  return (
    <section className="directory-view" aria-label="Katalog projektów">
      <div className="directory-create-grid">
        <section className="card">
          <div className="section-top">
            <div>
              <p className="section-kicker">NOWY PROJEKT</p>
              <h2>Dodaj projekt</h2>
            </div>
          </div>
          <form className="directory-create-form" onSubmit={handleCreateProject}>
            <label>
              Klient
              <select
                value={effectiveProjectClientId}
                disabled={busy || !loaded || activeClients.length === 0}
                onChange={e => setNewProjectClientId(e.target.value)}
              >
                {activeClients.length === 0 ? <option value="">Brak aktywnych klientów</option> : activeClients.map(client => (
                  <option key={client.id} value={client.id}>{clientLabelById.get(String(client.id)) ?? client.name}</option>
                ))}
              </select>
            </label>
            <label>
              Nazwa projektu
              <input
                value={newProjectName}
                disabled={busy || !loaded || !effectiveProjectClientId}
                maxLength={200}
                onChange={e => setNewProjectName(e.target.value)}
                placeholder="np. Redesign panelu"
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !loaded || !effectiveProjectClientId || !newProjectName.trim()}>Dodaj projekt</button>
          </form>
        </section>

        <section className="card">
          <div className="section-top">
            <div>
              <p className="section-kicker">NOWE ZADANIE</p>
              <h2>Dodaj zadanie</h2>
            </div>
          </div>
          <form className="directory-create-form" onSubmit={handleCreateTask}>
            <label>
              Projekt
              <select
                value={effectiveTaskProjectId}
                disabled={busy || !loaded || activeProjects.length === 0}
                onChange={e => setNewTaskProjectId(e.target.value)}
              >
                {activeProjects.length === 0 ? <option value="">Brak aktywnych projektów</option> : activeProjects.map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label>
              Nazwa zadania
              <input
                value={newTaskName}
                disabled={busy || !loaded || !effectiveTaskProjectId}
                maxLength={200}
                onChange={e => setNewTaskName(e.target.value)}
                placeholder="np. Nawigacja boczna"
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !loaded || !effectiveTaskProjectId || !newTaskName.trim()}>Dodaj zadanie</button>
          </form>
        </section>
      </div>

      {renameBox}

      <section className="card">
        <div className="section-top">
          <div>
            <p className="section-kicker">REJESTR</p>
            <h2>Lista projektów</h2>
          </div>
          <span className="count">{visibleProjects.length} z {projects.length}</span>
        </div>
        {controls}
        {!loaded ? (
          <p className="muted">Lista projektów jest niedostępna do czasu ponownego odczytu danych.</p>
        ) : visibleProjects.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">▣</div>
            <strong>{projects.length === 0 ? 'Brak projektów' : 'Brak pasujących projektów'}</strong>
            <p>{projects.length === 0 ? 'Dodaj klienta i pierwszy projekt, aby uruchamiać pomiary.' : 'Zmień filtr wyszukiwania lub włącz widoczność archiwum.'}</p>
          </div>
        ) : (
          <ul className="directory-list">
            {visibleProjects.map(project => {
              const owner = clients.find(client => same(client.id, project.client_id));
              const ownerLabel = owner ? (clientLabelById.get(String(owner.id)) ?? owner.name) : '—';
              const projectTasks = tasks.filter(task => same(task.project_id, project.id) && (showArchived || !task.archived));
              const colour = projectColour(project.id);
              const blockedByClient = Boolean(owner?.archived);
              return (
                <li key={project.id} className="directory-row" data-project-colour={colour} data-archived={project.archived || undefined}>
                  <div className="directory-row-main">
                    <div className="directory-project-title">
                      <span className="qp-dot" data-project-colour={colour} aria-hidden="true" />
                      <strong>{project.name}{project.archived ? ' (archiwum)' : ''}</strong>
                      <span className="count">{project.billable ? 'Rozliczalny domyślnie' : 'Nierozliczalny domyślnie'}</span>
                    </div>
                    <small className="muted">Klient: {ownerLabel}{owner?.archived ? ' (archiwum)' : ''} · Zadania: {projectTasks.length}</small>
                    {projectTasks.length > 0 && (
                      <div className="directory-pill-row">
                        {projectTasks.map(task => (
                          <button
                            key={task.id}
                            type="button"
                            className="secondary compact directory-task-chip"
                            disabled={busy || !loaded || project.archived || blockedByClient || task.archived}
                            onClick={() => {
                              onSelectTarget(String(project.client_id), String(project.id), String(task.id));
                              onOpenTimer();
                            }}
                          >
                            {task.name}{task.archived ? ' (archiwum)' : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="actions directory-row-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !loaded || project.archived || blockedByClient}
                      onClick={() => {
                        onSelectTarget(String(project.client_id), String(project.id), '');
                        onOpenTimer();
                      }}
                    >
                      Wybierz w timerze
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !loaded}
                      onClick={() => void onRunCommand(
                        () => invoke('set_project_billable', { projectId: Number(project.id), expected: project.billable, billable: !project.billable }),
                        'Zapisano domyślną rozliczalność projektu.',
                      )}
                    >
                      {project.billable ? 'Ustaw nierozliczalny' : 'Ustaw rozliczalny'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !loaded}
                      onClick={() => setEditing({ kind: 'project', id: project.id, expected: project.name, value: project.name })}
                    >
                      Zmień nazwę
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !loaded}
                      onClick={() => void onRunCommand(
                        () => invoke('archive_project', { projectId: Number(project.id), archived: !project.archived }),
                        project.archived ? 'Projekt przywrócony.' : 'Projekt przeniesiony do archiwum; historia pozostaje dostępna.',
                      )}
                    >
                      {project.archived ? 'Przywróć' : 'Archiwizuj'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
