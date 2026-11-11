/**
 * Prints Forge's types as TypeScript, with the wire's field names and no runtime
 * conversion: a type never claims a value the JSON doesn't hold.
 */
import type { Field, Forge, Model, ObjectType, Type } from '@cloudflare/forge/plugin';

/**
 * `read` is what the API sends, `write` what it receives. A model with `readOnly`
 * fields gets a type for each, because a shared model often requires a field that
 * only the server sets.
 */
export type Mode = 'read' | 'write';

/** Global names the printed types use, which a model must not shadow. */
const RESERVED = new Set(['Blob', 'FormData', 'BodyInit']);
/** A binary field in a form: a file, or text, as a KV value often is. */
const FILE_PART = 'Blob | string';

function pascal(text: string): string {
	const out = text
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join('');
	if (out === '') {
		return 'Model';
	}
	return /^[0-9]/.test(out) ? `_${out}` : out;
}

export function propertyKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function jsdoc(text: string | undefined, indent: string): string {
	const body = (text ?? '')
		.replaceAll('*/', '*\\/')
		.split('\n')
		.map((line) => line.trimEnd());
	while (body.length > 0 && body.at(-1) === '') {
		body.pop();
	}
	if (body.length === 0) {
		return '';
	}
	if (body.length === 1) {
		return `${indent}/** ${body[0]} */\n`;
	}
	return `${indent}/**\n${body.map((line) => `${indent} * ${line}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

export function namespaceOf(prefix: string): string {
	return `$${prefix.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/** The file of a model: the part of its schema name before the first `_`. */
function splitName(schemaName: string): { prefix: string; rest: string } {
	const split = schemaName.indexOf('_');
	return {
		prefix: (split === -1 ? schemaName : schemaName.slice(0, split)).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
		rest: split === -1 ? schemaName : schemaName.slice(split + 1),
	};
}

/** The models: which file and name each has, and which ones the output uses. */
export class Models {
	readonly #names = new Map<Model, { prefix: string; read: string; write: string }>();
	readonly #modeSensitive = new Set<Model>();
	readonly #fileHolders = new Set<Model>();
	readonly #used = new Set<string>();
	/** The models used and not printed yet. */
	readonly queue: { model: Model; mode: Mode }[] = [];

	constructor(forge: Forge) {
		const all = forge.groups.flatMap((group) => group.models).sort((a, b) =>
			a.schemaName < b.schemaName ? -1 : 1,
		);
		const taken = new Map<string, Set<string>>();
		const claim = (prefix: string, wanted: string): string => {
			const names = taken.get(prefix) ?? new Set<string>();
			taken.set(prefix, names);
			let name = RESERVED.has(wanted) ? `${wanted}_` : wanted;
			for (let n = 2; names.has(name); n++) {
				name = `${wanted}_${n}`;
			}
			names.add(name);
			return name;
		};
		for (const model of all) {
			const { prefix, rest } = splitName(model.schemaName);
			this.#names.set(model, { prefix, read: claim(prefix, pascal(rest)), write: '' });
		}
		// Input names come second, so a model's own name never changes because of one.
		for (const model of all) {
			const entry = this.#names.get(model)!;
			entry.write = claim(entry.prefix, `${entry.read}Input`);
		}
		this.#classify(all);
	}

	/**
	 * A model differs between modes when it, or a model it refers to, has a `readOnly`
	 * field. It holds a file when it, or a model it refers to, has a binary field.
	 */
	#classify(all: readonly Model[]): void {
		const edges = new Map<Model, Set<Model>>();
		const walk = (type: Type, owner: Model): void => {
			switch (type.kind) {
				case 'scalar':
					if (type.scalar === 'binary') {
						this.#fileHolders.add(owner);
					}
					break;
				case 'model':
					edges.get(owner)!.add(type.model);
					break;
				case 'array':
					walk(type.elem, owner);
					break;
				case 'union':
				case 'intersection':
					type.members.forEach((member) => walk(member, owner));
					break;
				case 'object':
					for (const field of type.fields) {
						if (field.readOnly) {
							this.#modeSensitive.add(owner);
						}
						walk(field.type, owner);
					}
					if (type.extra) {
						walk(type.extra, owner);
					}
					break;
				default:
					break;
			}
		};
		for (const model of all) {
			edges.set(model, new Set());
			walk(model.type, model);
		}
		for (const set of [this.#modeSensitive, this.#fileHolders]) {
			for (let changed = true; changed; ) {
				changed = false;
				for (const [model, targets] of edges) {
					if (!set.has(model) && [...targets].some((target) => set.has(target))) {
						set.add(model);
						changed = true;
					}
				}
			}
		}
	}

	holdsFile(model: Model): boolean {
		return this.#fileHolders.has(model);
	}

	/**
	 * Records that the output uses a model, and returns where it is. A model is printed
	 * once, with its binary fields as files, so it can't also be used where JSON is sent.
	 */
	use(model: Model, mode: Mode, form: boolean): { prefix: string; ident: string } {
		if (!form && this.#fileHolders.has(model)) {
			throw new Error(`The model ${model.schemaName} holds a file, and is now used outside a form. It needs a variant for each.`);
		}
		const effective: Mode = mode === 'write' && this.#modeSensitive.has(model) ? 'write' : 'read';
		const key = `${effective}:${model.schemaName}`;
		if (!this.#used.has(key)) {
			this.#used.add(key);
			this.queue.push({ model, mode: effective });
		}
		return this.location(model, effective);
	}

	location(model: Model, mode: Mode): { prefix: string; ident: string } {
		const entry = this.#names.get(model);
		if (!entry) {
			throw new Error(`The model ${model.schemaName} is in no group.`);
		}
		return { prefix: entry.prefix, ident: mode === 'write' ? entry.write : entry.read };
	}
}

export function parenthesize(text: string): string {
	return /[|&]/.test(text) ? `(${text})` : text;
}

export class Printer {
	readonly models: Models;
	readonly prefix: string | undefined;
	/** The other model files this file refers to. */
	readonly imports = new Set<string>();
	/** Whether binary strings are files, as they are in a form body. */
	form = false;

	constructor(models: Models, prefix: string | undefined) {
		this.models = models;
		this.prefix = prefix;
	}

	type(type: Type | undefined, mode: Mode, indent = ''): string {
		if (type === undefined) {
			return 'unknown';
		}
		switch (type.kind) {
			case 'scalar':
				return this.#scalar(type.scalar);
			case 'enum':
				return type.values.map((value) => JSON.stringify(value)).join(' | ');
			case 'array':
				return `${parenthesize(this.type(type.elem, mode, indent))}[]`;
			case 'model':
				return this.#reference(type.model, mode);
			case 'object':
				return this.#object(type, mode, indent);
			case 'union': {
				const members = [...new Set(type.members.map((member) => this.type(member, mode, indent)))];
				if (members.includes('unknown')) {
					return 'unknown';
				}
				return (members.includes(FILE_PART) ? members.filter((member) => member !== 'string') : members).join(' | ');
			}
			case 'intersection': {
				const members = type.members
					.map((member) => this.type(member, mode, indent))
					.filter((member) => member !== 'unknown');
				return members.length === 0 ? 'unknown' : members.map(parenthesize).join(' & ');
			}
		}
	}

	#scalar(scalar: string): string {
		switch (scalar) {
			case 'unknown':
				return 'unknown';
			case 'null':
				return 'null';
			case 'boolean':
				return 'boolean';
			case 'number':
				return 'number';
			case 'binary':
				return this.form ? FILE_PART : 'string';
			default:
				// A date, a UUID and base64 bytes are strings on the wire.
				return 'string';
		}
	}

	#reference(model: Model, mode: Mode): string {
		const target = this.models.use(model, mode, this.form);
		if (target.prefix === this.prefix) {
			return target.ident;
		}
		this.imports.add(target.prefix);
		return `${namespaceOf(target.prefix)}.${target.ident}`;
	}

	#field(field: Field, mode: Mode, indent: string): string {
		const notes = [field.description, field.deprecated ? '@deprecated' : undefined].filter(Boolean).join('\n');
		// A `readOnly` field stays optional rather than absent, so a value read from
		// the API can be sent back, and a mislabelled field can still be sent.
		const optional = !field.required || (mode === 'write' && field.readOnly);
		const key = `${propertyKey(field.wireName)}${optional ? '?' : ''}`;
		return `${jsdoc(notes, indent)}${indent}${key}: ${this.type(field.type, mode, indent)};\n`;
	}

	#object(type: ObjectType, mode: Mode, indent: string): string {
		if (type.fields.length === 0) {
			return `{ [key: string]: ${type.extra ? this.type(type.extra, mode, indent) : 'unknown'} }`;
		}
		const inner = `${indent}\t`;
		let out = '{\n';
		for (const field of type.fields) {
			out += this.#field(field, mode, inner);
		}
		if (type.extra) {
			out += `${inner}[key: string]: unknown;\n`;
		}
		return `${out}${indent}}`;
	}
}
