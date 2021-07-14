/**
 * Logic for interfacing between ProseMirror and CRDT.
 */

import Micromerge, { OperationPath, Patch } from "./micromerge"
import { EditorState, Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { Schema, Slice, Node, Fragment } from "prosemirror-model"
import { baseKeymap, Command, Keymap, toggleMark } from "prosemirror-commands"
import { keymap } from "prosemirror-keymap"
import { ALL_MARKS, isMarkType, MarkType, schemaSpec } from "./schema"
import { ReplaceStep, AddMarkStep, RemoveMarkStep } from "prosemirror-transform"
import { ChangeQueue } from "./changeQueue"
import type { DocSchema } from "./schema"
import type { Publisher } from "./pubsub"
import type {
    ActorId,
    Char,
    FormatSpanWithText,
    Change,
    Operation as InternalOperation,
    InputOperation,
} from "./micromerge"
import type { Comment, CommentId } from "./comment"
import { MarkValue } from "./format"
import { v4 as uuid } from "uuid"

const schema = new Schema(schemaSpec)

export type RootDoc = {
    text: Array<Char>
    comments: Record<CommentId, Comment>
}

// This is a factory which returns a Prosemirror command.
// The Prosemirror command adds a mark to the document.
// The mark takes on the position of the current selection,
// and has the given type and attributes.
// (The structure/usage of this is similar to the toggleMark command factory
// built in to prosemirror)
function addMark<M extends MarkType>(args: {
    markType: M
    makeAttrs: () => Omit<MarkValue[M], "opId" | "active">
}) {
    const { markType, makeAttrs } = args
    const command: Command<DocSchema> = (
        state: EditorState,
        dispatch: ((t: Transaction<DocSchema>) => void) | undefined,
    ) => {
        const tr = state.tr
        const { $from, $to } = state.selection.ranges[0]
        const from = $from.pos,
            to = $to.pos
        tr.addMark(from, to, schema.marks[markType].create(makeAttrs()))
        if (dispatch !== undefined) {
            dispatch(tr)
        }
        return true
    }
    return command
}

const richTextKeymap: Keymap<DocSchema> = {
    ...baseKeymap,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-e": addMark({
        markType: "comment",
        makeAttrs: () => ({ id: uuid() }),
    }),
    "Mod-k": addMark({
        markType: "link",
        makeAttrs: () => ({
            url: `https://www.google.com/search?q=${uuid()}`,
        }),
    }),
}

export type Editor = {
    doc: Micromerge
    view: EditorView
    queue: ChangeQueue
}

// Returns a natural language description of an op in our CRDT.
// Just for demo / debug purposes, doesn't cover all cases
function describeOp(op: InternalOperation): string {
    if (op.action === "set" && op.elemId !== undefined) {
        return `insert "${op.value}" after char ID <strong>${String(
            op.elemId,
        )}</strong>`
    } else if (op.action === "del" && op.elemId !== undefined) {
        return `delete <strong>${String(op.elemId)}</strong>`
    } else if (op.action === "addMark") {
        return `add mark <strong>${op.markType}</strong> from <strong>${op.start}</strong> to <strong>${op.end}</strong>`
    } else if (op.action === "removeMark") {
        return `remove mark <strong>${op.markType}</strong> from <strong>${op.start}</strong> to <strong>${op.end}</strong>`
    } else {
        return op.action
    }
}

/** Initialize multiple Micromerge docs to all have same base editor state.
 *  The key is that all docs get initialized with a single change that originates
 *  on one of the docs; this avoids weird issues where each doc independently
 *  tries to initialize the basic structure of the document.
 */
export const initializeDocs = (docs: Micromerge[]): void => {
    const initialValue = "This is the Peritext editor"
    const initialChange = docs[0].change([
        { path: [], action: "makeList", key: Micromerge.contentKey },
        {
            path: [Micromerge.contentKey],
            action: "insert",
            index: 0,
            values: initialValue.split(""),
        },
    ])
    for (const doc of docs.slice(1)) {
        doc.applyChange(initialChange)
    }
}

/** Extends a Prosemirror Transaction with new steps incorporating
 *  the effects of a Micromerge Patch.
 *
 *  @param transaction - the original transaction to extend
 *  @param patch - the Micromerge Patch to incorporate
 *  @returns a Transaction that includes additional steps representing the patch
 *    */
const applyPatchToTransaction = (
    transaction: Transaction,
    patch: Patch,
): Transaction => {
    switch (patch.action) {
        case "insert": {
            const index = patch.index + 1 // path is in plaintext string; account for paragraph node
            return transaction.replace(
                index,
                index,
                new Slice(Fragment.from(schema.text(patch.values[0])), 0, 0),
            )
        }

        case "delete": {
            const index = patch.index + 1 // path is in plaintext string; account for paragraph node
            return transaction.replace(index, index + patch.count, Slice.empty)
        }

        case "makeList": {
            // This detects the case where the patch is re-initializing the entire content
            if (
                patch.path.length === 0 &&
                patch.key === Micromerge.contentKey
            ) {
                return transaction.replace(
                    0,
                    transaction.doc.content.size,
                    Slice.empty,
                )
            } else {
                return transaction
            }
        }
        case "addMark": {
            return transaction.addMark(
                patch.start + 1,
                patch.end +
                    1 /* Adjust for ProseMirror paragraph offset */ +
                    1 /* Our end is inclusive, their end is exclusive */,
                schema.mark(patch.markType, patch.attrs),
            )
        }
        case "removeMark": {
            return transaction.removeMark(
                patch.start + 1,
                patch.end +
                    1 /* Adjust for ProseMirror paragraph offset */ +
                    1 /* Our end is inclusive, their end is exclusive */,
                schema.mark(patch.markType, patch.attrs),
            )
        }
    }
    unreachable(patch)
}

export function createEditor(args: {
    actorId: ActorId
    editorNode: Element
    changesNode: Element
    doc: Micromerge
    publisher: Publisher<Array<Change>>
    handleClickOn?: (
        this: unknown,
        view: EditorView<Schema>,
        pos: number,
        node: Node<Schema>,
        nodePos: number,
        event: MouseEvent,
        direct: boolean,
    ) => boolean
}): Editor {
    const { actorId, editorNode, changesNode, doc, publisher, handleClickOn } =
        args
    const queue = new ChangeQueue({
        handleFlush: (changes: Array<Change>) => {
            publisher.publish(actorId, changes)
        },
    })
    queue.start()

    const outputDebugForChange = (change: Change, txn: Transaction<Schema>) => {
        const opsHtml = change.ops
            .map(
                (op: InternalOperation) =>
                    `<div class="change-description"><span class="de-emphasize">Micromerge:</span> ${describeOp(
                        op,
                    )}</div>`,
            )
            .join("")

        const stepsHtml = txn.steps
            .map(step => {
                let stepText = ""
                if (step instanceof ReplaceStep) {
                    const stepContent = step.slice.content.textBetween(
                        0,
                        step.slice.content.size,
                    )
                    if (step.slice.size === 0) {
                        if (step.to - 1 === step.from) {
                            // single character deletion
                            stepText = `delete at index <strong>${step.from}</strong>`
                        } else {
                            stepText = `delete from index <strong>${
                                step.from
                            }</strong> to <strong>${step.to - 1}</strong>`
                        }
                    } else if (step.from === step.to) {
                        stepText = `insert "${stepContent}" at index <strong>${step.from}</strong>`
                    } else {
                        stepText = `replace index <strong>${step.from}</strong> to <strong>${step.to}</strong> with: "${stepContent}"`
                    }
                } else if (step instanceof AddMarkStep) {
                    stepText = `add mark ${step.mark.type.name} from index <strong>${step.from}</strong> to <strong>${step.to}</strong>`
                } else if (step instanceof RemoveMarkStep) {
                    stepText = `remove mark ${step.mark.type.name} from index <strong>${step.from}</strong> to <strong>${step.to}</strong>`
                } else {
                    stepText = `unknown step type: ${step.toJSON().type}`
                }

                return `<div class="prosemirror-step"><span class="de-emphasize">Prosemirror:</span> ${stepText}</div>`
            })
            .join("")

        changesNode.insertAdjacentHTML(
            "beforeend",
            `<div class="change from-${change.actor}">
                <div class="ops">${opsHtml}</div>
                <div class="prosemirror-steps">${stepsHtml}</div>
            </div>`,
        )
        changesNode.scrollTop = changesNode.scrollHeight
    }

    publisher.subscribe(actorId, incomingChanges => {
        if (incomingChanges.length === 0) {
            return
        }

        let state = view.state

        // For each incoming change, we:
        // - retrieve Patches from Micromerge describing the effect of applying the change
        // - construct a Prosemirror Transaction representing those effecst
        // - apply that Prosemirror Transaction to the document
        for (const change of incomingChanges) {
            let transaction = state.tr
            const patches = doc.applyChange(change)
            for (const patch of patches) {
                transaction = applyPatchToTransaction(transaction, patch)
            }
            console.log("applying incremental transaction for remote update", {
                steps: transaction.steps,
            })
            state = state.apply(transaction)
            outputDebugForChange(change, transaction)
        }

        view.updateState(state)
    })

    // Generate an empty document conforming to the schema,
    // and a default selection at the start of the document.
    const state = EditorState.create({
        schema,
        plugins: [keymap(richTextKeymap)],
        doc: prosemirrorDocFromCRDT({
            schema,
            spans: doc.getTextWithFormatting([Micromerge.contentKey]),
        }),
    })

    // Create a view for the state and generate transactions when the user types.
    const view = new EditorView(editorNode, {
        // state.doc is a read-only data structure using a node hierarchy
        // A node contains a fragment with zero or more child nodes.
        // Text is modeled as a flat sequence of tokens.
        // Each document has a unique valid representation.
        // Order of marks specified by schema.
        state,
        handleClickOn,
        // Intercept transactions.
        dispatchTransaction: (txn: Transaction) => {
            let state = view.state
            console.groupCollapsed("dispatch", txn.steps[0])

            // Locally apply the Prosemirror transaction directly to this document
            state = state.apply(txn)

            // Apply a corresponding change to the Micromerge document
            const change = applyTransaction({ doc, txn })
            if (change) {
                queue.enqueue(change)
                outputDebugForChange(change, txn)
            }

            console.log("new state", state)
            console.log(txn.selection)

            view.updateState(state)

            console.log(
                "steps",
                txn.steps.map(s => s.toJSON()),
                "newState",
                state,
            )
            console.groupEnd()
        },
    })

    return { doc, view, queue }
    ;("")
}

/**
 * Converts a position in the Prosemirror doc to an offset in the CRDT content string.
 * For now we only have a single node so this is relatively trivial.
 * When things get more complicated with multiple nodes, we can probably take advantage
 * of the additional metadata that Prosemirror can provide by "resolving" the position.
 * @param position : an unresolved Prosemirror position in the doc;
 * @returns
 */
function contentPosFromProsemirrorPos(position: number) {
    return position - 1
}

// Given a micromerge doc representation, produce a prosemirror doc.
export function prosemirrorDocFromCRDT(args: {
    schema: DocSchema
    spans: FormatSpanWithText[]
}): Node {
    const { schema, spans } = args

    // Prosemirror doesn't allow for empty text nodes;
    // if our doc is empty, we short-circuit and don't add any text nodes.
    if (spans.length === 1 && spans[0].text === "") {
        return schema.node("doc", undefined, [schema.node("paragraph", [])])
    }

    const result = schema.node("doc", undefined, [
        schema.node(
            "paragraph",
            undefined,
            spans.map(span => {
                const marks = []
                for (const markType of ALL_MARKS) {
                    const markValue = span.marks[markType]
                    if (markValue === undefined) {
                        continue
                    }
                    if (Array.isArray(markValue)) {
                        for (const value of markValue) {
                            marks.push(schema.mark(markType, value))
                        }
                    } else {
                        if (markValue.active) {
                            marks.push(schema.mark(markType, markValue))
                        }
                    }
                }
                return schema.text(span.text, marks)
            }),
        ),
    ])

    return result
}

// Given a CRDT Doc and a Prosemirror Transaction, update the micromerge doc.
// Note: need to derive a PM doc from the new CRDT doc later!
// TODO: why don't we need to update the selection when we do insertions?
export function applyTransaction(args: {
    doc: Micromerge
    txn: Transaction<DocSchema>
}): Change | null {
    const { doc, txn } = args
    const operations: Array<InputOperation> = []

    for (const step of txn.steps) {
        console.log("step", step)

        if (step instanceof ReplaceStep) {
            if (step.slice) {
                // handle insertion
                if (step.from !== step.to) {
                    operations.push({
                        path: [Micromerge.contentKey],
                        action: "delete",
                        index: contentPosFromProsemirrorPos(step.from),
                        count: step.to - step.from,
                    })
                }

                const insertedContent = step.slice.content.textBetween(
                    0,
                    step.slice.content.size,
                )

                operations.push({
                    path: [Micromerge.contentKey],
                    action: "insert",
                    index: contentPosFromProsemirrorPos(step.from),
                    values: insertedContent.split(""),
                })
            } else {
                // handle deletion
                operations.push({
                    path: [Micromerge.contentKey],
                    action: "delete",
                    index: contentPosFromProsemirrorPos(step.from),
                    count: step.to - step.from,
                })
            }
        } else if (step instanceof AddMarkStep) {
            if (!isMarkType(step.mark.type.name)) {
                throw new Error(`Invalid mark type: ${step.mark.type.name}`)
            }

            const start = contentPosFromProsemirrorPos(step.from)
            // The end of a prosemirror addMark step refers to the index _after_ the end,
            // but in the CRDT we use the index of the last character in the range.
            // TODO: define a helper that converts a whole Prosemirror range into a
            // CRDT range, not just a single position at a time.
            const end = contentPosFromProsemirrorPos(step.to - 1)

            const partialOp: {
                action: "addMark"
                path: OperationPath
                start: number
                end: number
            } = {
                action: "addMark",
                path: [Micromerge.contentKey],
                start,
                end,
            }

            if (step.mark.type.name === "comment") {
                if (
                    !step.mark.attrs ||
                    typeof step.mark.attrs.id !== "string"
                ) {
                    throw new Error("Expected comment mark to have id attrs")
                }
                operations.push({
                    ...partialOp,
                    markType: step.mark.type.name,
                    attrs: step.mark.attrs as { id: string },
                })
            } else if (step.mark.type.name === "link") {
                if (
                    !step.mark.attrs ||
                    typeof step.mark.attrs.url !== "string"
                ) {
                    throw new Error("Expected link mark to have url attrs")
                }
                operations.push({
                    ...partialOp,
                    markType: step.mark.type.name,
                    attrs: step.mark.attrs as { url: string },
                })
            } else {
                operations.push({
                    ...partialOp,
                    markType: step.mark.type.name,
                })
            }
        } else if (step instanceof RemoveMarkStep) {
            if (!isMarkType(step.mark.type.name)) {
                throw new Error(`Invalid mark type: ${step.mark.type.name}`)
            }

            const start = contentPosFromProsemirrorPos(step.from)
            const end = contentPosFromProsemirrorPos(step.to - 1)

            const partialOp: {
                action: "removeMark"
                path: OperationPath
                start: number
                end: number
            } = {
                action: "removeMark",
                path: [Micromerge.contentKey],
                start,
                end,
            }

            if (step.mark.type.name === "comment") {
                if (
                    !step.mark.attrs ||
                    typeof step.mark.attrs.id !== "string"
                ) {
                    throw new Error("Expected comment mark to have id attrs")
                }
                operations.push({
                    ...partialOp,
                    markType: step.mark.type.name,
                    attrs: step.mark.attrs as { id: string },
                })
            } else {
                operations.push({
                    ...partialOp,
                    markType: step.mark.type.name,
                })
            }
        }
    }

    if (operations.length > 0) {
        return doc.change(operations)
    } else {
        return null
    }
}
