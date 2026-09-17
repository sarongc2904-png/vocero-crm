"use client";

import { useEffect, useMemo, useState } from "react";

type Assignment =
  | { kind: "member"; id: string; name: string }
  | { kind: "team"; id: string; name: string }
  | null;

type Team = {
  id: string;
  name: string;
  members: Array<{
    memberId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
  }>;
};

export function AssignmentControl({ conversationId }: { conversationId: string }) {
  const [assignment, setAssignment] = useState<Assignment>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    void Promise.all([
      fetch(`/api/conversations/${conversationId}/assignment`).then((r) =>
        r.ok ? r.json() : null
      ),
      fetch("/api/settings/teams").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([assignmentRes, teamsRes]) => {
        if (cancelled) return;
        setAssignment(assignmentRes?.assignment ?? null);
        setTeams(teamsRes?.teams ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo cargar la asignación");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const members = useMemo(() => {
    const unique = new Map<string, Team["members"][number]>();
    for (const team of teams) {
      for (const member of team.members) unique.set(member.memberId, member);
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [teams]);

  const value = assignment ? `${assignment.kind}:${assignment.id}` : "none";

  async function change(next: string) {
    setSaving(true);
    setError(null);
    const [kind, id] = next.split(":", 2);
    const body =
      kind === "none"
        ? { kind: "none" }
        : kind === "member"
          ? { kind: "member", id }
          : { kind: "team", id };

    const res = await fetch(`/api/conversations/${conversationId}/assignment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);

    if (!res?.ok) {
      setError("No se pudo cambiar la asignación");
      setSaving(false);
      return;
    }
    const data = (await res.json()) as { assignment: Assignment };
    setAssignment(data.assignment ?? null);
    setSaving(false);
  }

  return (
    <div className="mt-3 rounded-md border bg-subtle px-3 py-2.5">
      <label className="block text-[13px] font-medium" htmlFor="conversation-assignment">
        Responsable
      </label>
      <select
        id="conversation-assignment"
        className="mt-1.5 w-full rounded-md border bg-background px-2.5 py-2 text-xs outline-none focus:border-brand"
        value={value}
        disabled={!loaded || saving}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="none">Sin asignar</option>
        {members.length > 0 && (
          <optgroup label="Agentes">
            {members.map((member) => (
              <option key={member.memberId} value={`member:${member.memberId}`}>
                {member.name} · {member.role}
              </option>
            ))}
          </optgroup>
        )}
        {teams.length > 0 && (
          <optgroup label="Equipos">
            {teams.map((team) => (
              <option key={team.id} value={`team:${team.id}`}>
                {team.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <p className="mt-1 text-[10.5px] text-text-3">
        {saving
          ? "Guardando asignación…"
          : assignment
            ? `Asignado a ${assignment.name}`
            : "Disponible para el equipo"}
      </p>
      {error && <p className="mt-1 text-[10.5px] text-destructive">{error}</p>}
    </div>
  );
}
