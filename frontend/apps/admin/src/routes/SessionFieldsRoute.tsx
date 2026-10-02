import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { InlineEditableText } from "../components/InlineEditableText";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import type { Division, FieldRead, FieldSetRead, SessionRead } from "../types";

type PendingDelete =
  | { kind: "field"; id: number; fieldSetId: number; name: string }
  | { kind: "fieldSet"; id: number; name: string };

function cardIdOf(target: PendingDelete): number {
  return target.kind === "field" ? target.fieldSetId : target.id;
}

export function SessionFieldsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const [firstFieldName, setFirstFieldName] = useState("");
  const [newFieldNames, setNewFieldNames] = useState<Record<number, string>>({});
  const [newSetName, setNewSetName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({});
  const generic = t("errors.generic");

  const fieldSetsQuery = useQuery({
    queryKey: ["fieldSets", session.id],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${session.id}`),
  });
  const fieldsQuery = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["fieldSets", session.id] });
    queryClient.invalidateQueries({ queryKey: ["fields", session.id] });
  }

  function setCardError(fieldSetId: number, message: string | null) {
    setCardErrors((previous) => {
      const next = { ...previous };
      if (message === null) delete next[fieldSetId];
      else next[fieldSetId] = message;
      return next;
    });
  }

  const createFieldMutation = useMutation({
    mutationFn: ({ name, fieldSetId }: { name: string; fieldSetId: number | null }) =>
      apiRequest<FieldRead>("/api/fields", {
        method: "POST",
        body:
          fieldSetId === null
            ? { session_id: session.id, name }
            : { session_id: session.id, name, field_set_id: fieldSetId },
      }),
    onSuccess: (_field, { fieldSetId }) => {
      if (fieldSetId === null) {
        setFirstFieldName("");
      } else {
        setNewFieldNames((previous) => ({ ...previous, [fieldSetId]: "" }));
        setCardError(fieldSetId, null);
      }
      refresh();
    },
    onError: (error, { fieldSetId }) => {
      if (fieldSetId !== null) setCardError(fieldSetId, apiErrorMessage(error, generic));
    },
  });

  const createSetMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<FieldSetRead>("/api/field-sets", {
        method: "POST",
        body: { session_id: session.id, name },
      }),
    onSuccess: () => {
      setNewSetName("");
      refresh();
    },
  });

  const renameSetMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiRequest<FieldSetRead>(`/api/field-sets/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: refresh,
  });

  const assignDivisionMutation = useMutation({
    mutationFn: ({ id, divisionId }: { id: number; divisionId: number | null }) =>
      apiRequest<FieldSetRead>(`/api/field-sets/${id}`, {
        method: "PATCH",
        body: { division_id: divisionId },
      }),
    onSuccess: (_set, { id }) => {
      setCardError(id, null);
      refresh();
    },
    onError: (error, { id }) => setCardError(id, apiErrorMessage(error, generic)),
  });

  const renameFieldMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiRequest<FieldRead>(`/api/fields/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: (target: PendingDelete) =>
      apiRequest<void>(
        target.kind === "field" ? `/api/fields/${target.id}` : `/api/field-sets/${target.id}`,
        { method: "DELETE" }
      ),
    onSuccess: (_result, target) => {
      setCardError(cardIdOf(target), null);
      refresh();
    },
    onError: (error, target) => setCardError(cardIdOf(target), apiErrorMessage(error, generic)),
    onSettled: () => setPendingDelete(null),
  });

  if (fieldSetsQuery.isLoading || fieldsQuery.isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }

  const fieldSets = fieldSetsQuery.data ?? [];
  const fields = fieldsQuery.data ?? [];
  const multiDivision = (divisions?.length ?? 0) > 1;

  return (
    <div className="session-fields">
      {fieldSets.length === 0 ? (
        <div className="panel">
          <p>{t("sessions.fields.empty")}</p>
          <form
            className="form-actions"
            onSubmit={(event) => {
              event.preventDefault();
              const name = firstFieldName.trim();
              if (name) createFieldMutation.mutate({ name, fieldSetId: null });
            }}
          >
            <input
              className="input"
              aria-label={t("sessions.fields.firstFieldLabel")}
              placeholder={t("sessions.fields.firstFieldLabel")}
              value={firstFieldName}
              onChange={(event) => setFirstFieldName(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary btn-small"
              disabled={!firstFieldName.trim() || createFieldMutation.isPending}
            >
              {t("sessions.fields.addFieldAction")}
            </button>
          </form>
          {createFieldMutation.isError && createFieldMutation.variables?.fieldSetId === null && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(createFieldMutation.error, generic)}
            </p>
          )}
        </div>
      ) : (
        fieldSets.map((fieldSet) => {
          const setFields = fields.filter((field) => field.field_set_id === fieldSet.id);
          const newFieldName = newFieldNames[fieldSet.id] ?? "";
          const renamingThisSet = renameSetMutation.variables?.id === fieldSet.id;
          return (
            <section key={fieldSet.id} className="panel field-set-card" aria-label={fieldSet.name}>
              <div className="field-set-card__header">
                <InlineEditableText
                  value={fieldSet.name}
                  onSave={(name) => renameSetMutation.mutate({ id: fieldSet.id, name })}
                  onCancel={() => renameSetMutation.reset()}
                  isSaving={renameSetMutation.isPending && renamingThisSet}
                  error={
                    renameSetMutation.isError && renamingThisSet
                      ? apiErrorMessage(renameSetMutation.error, generic)
                      : null
                  }
                  editLabel={t("sessions.fields.renameSetAction", { name: fieldSet.name })}
                  saveLabel={t("sessions.saveAction")}
                  cancelLabel={t("sessions.cancelAction")}
                  inputLabel={t("sessions.fields.setNameLabel")}
                />
                {multiDivision && (
                  <label className="field-set-card__division">
                    <span>{t("sessions.fields.divisionLabel")}</span>
                    <select
                      className="select"
                      value={fieldSet.division_id ?? ""}
                      onChange={(event) =>
                        assignDivisionMutation.mutate({
                          id: fieldSet.id,
                          divisionId: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                    >
                      <option value="">{t("sessions.fields.unassignedOption")}</option>
                      {(divisions ?? []).map((division) => (
                        <option key={division.id} value={division.id}>
                          {division.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() =>
                    setPendingDelete({ kind: "fieldSet", id: fieldSet.id, name: fieldSet.name })
                  }
                >
                  {t("sessions.fields.deleteSetAction")}
                </button>
              </div>
              {multiDivision && fieldSet.division_id === null && (
                <p className="field__hint">{t("sessions.fields.unassignedNote")}</p>
              )}
              <ul className="list-plain">
                {setFields.map((field) => {
                  const renamingThisField = renameFieldMutation.variables?.id === field.id;
                  return (
                    <li key={field.id} className="list-row">
                      <InlineEditableText
                        value={field.name}
                        onSave={(name) => renameFieldMutation.mutate({ id: field.id, name })}
                        onCancel={() => renameFieldMutation.reset()}
                        isSaving={renameFieldMutation.isPending && renamingThisField}
                        error={
                          renameFieldMutation.isError && renamingThisField
                            ? apiErrorMessage(renameFieldMutation.error, generic)
                            : null
                        }
                        editLabel={t("sessions.fields.renameFieldAction", { name: field.name })}
                        saveLabel={t("sessions.saveAction")}
                        cancelLabel={t("sessions.cancelAction")}
                        inputLabel={t("sessions.fields.fieldNameLabel")}
                      />
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.fields.removeFieldAriaLabel", { name: field.name })}
                        onClick={() =>
                          setPendingDelete({
                            kind: "field",
                            id: field.id,
                            fieldSetId: fieldSet.id,
                            name: field.name,
                          })
                        }
                      >
                        {t("sessions.fields.removeFieldAction")}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <form
                className="form-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = newFieldName.trim();
                  if (name) createFieldMutation.mutate({ name, fieldSetId: fieldSet.id });
                }}
              >
                <input
                  className="input"
                  aria-label={t("sessions.fields.newFieldLabel", { name: fieldSet.name })}
                  placeholder={t("sessions.fields.newFieldPlaceholder")}
                  value={newFieldName}
                  onChange={(event) =>
                    setNewFieldNames((previous) => ({ ...previous, [fieldSet.id]: event.target.value }))
                  }
                />
                <button type="submit" className="btn btn-small" disabled={!newFieldName.trim()}>
                  {t("sessions.fields.addFieldAction")}
                </button>
              </form>
              {cardErrors[fieldSet.id] && (
                <p className="alert alert-danger" role="alert">
                  {cardErrors[fieldSet.id]}
                </p>
              )}
            </section>
          );
        })
      )}
      <form
        className="form-actions"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newSetName.trim();
          if (name) createSetMutation.mutate(name);
        }}
      >
        <input
          className="input"
          aria-label={t("sessions.fields.newSetLabel")}
          placeholder={t("sessions.fields.newSetLabel")}
          value={newSetName}
          onChange={(event) => setNewSetName(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-small"
          disabled={!newSetName.trim() || createSetMutation.isPending}
        >
          {t("sessions.fields.addSetAction")}
        </button>
      </form>
      {createSetMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(createSetMutation.error, generic)}
        </p>
      )}
      {pendingDelete && (
        <ConfirmDialog
          heading={
            pendingDelete.kind === "field"
              ? t("sessions.fields.deleteFieldHeading", { name: pendingDelete.name })
              : t("sessions.fields.deleteSetHeading", { name: pendingDelete.name })
          }
          body={
            pendingDelete.kind === "field"
              ? t("sessions.fields.deleteFieldBody")
              : t("sessions.fields.deleteSetBody")
          }
          confirmLabel={t("sessions.fields.confirmDelete")}
          cancelLabel={t("sessions.cancelAction")}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
