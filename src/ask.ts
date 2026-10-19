import {
  ActionRowBuilder,
  ComponentType,
  escapeMarkdown,
  StringSelectMenuBuilder,
  type Message,
  type SendableChannels,
} from "discord.js";
import type { Question } from "./claude";

// Discord's message length limit
const MAX_MESSAGE = 2000;

// Discord's limits on a select menu: options, and the length of a label,
// description or placeholder
const MAX_OPTIONS = 25;
const MAX_LABEL = 100;
const MAX_PLACEHOLDER = 150;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A question waiting in a channel. Each question gets a select menu, and a
// typed message answers every question still open, for answers the options don't
// cover. Aborting the signal skips the questions and rejects answered.
export class Asking {
  private readonly answers = new Map<number, string>();
  private readonly done = Promise.withResolvers<Record<string, string>>();
  readonly answered = this.done.promise;

  private constructor(private readonly questions: readonly Question[]) {}

  static async post(channel: SendableChannels, questions: readonly Question[], signal: AbortSignal): Promise<Asking> {
    const asking = new Asking(questions);
    const rows = questions.map((q, i) => {
      const options = q.options.slice(0, MAX_OPTIONS);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(String(i))
        .setPlaceholder(cut(q.header || q.question, MAX_PLACEHOLDER))
        .setMinValues(1)
        .setMaxValues(q.multiSelect ? options.length : 1)
        .addOptions(
          options.map((o, j) => ({
            label: cut(o.label, MAX_LABEL),
            value: String(j),
            ...(o.description ? { description: cut(o.description, MAX_LABEL) } : {}),
          })),
        );
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    });
    const content = `${questions.map((q) => `**${escapeMarkdown(q.question)}**`).join("\n")}\n-# Pick below, or type an answer.`;
    const message: Message = await channel.send({ content: cut(content, MAX_MESSAGE), components: rows });

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect });
    collector.on("collect", (interaction) => {
      const i = Number(interaction.customId);
      const options = questions[i]!.options;
      asking.answers.set(i, interaction.values.map((v) => options[Number(v)]!.label).join(", "));
      interaction.deferUpdate().catch(() => {});
      asking.check();
    });
    const skip = () => asking.done.reject(new Error("the questions were skipped"));
    if (signal.aborted) skip();
    else signal.addEventListener("abort", skip, { once: true });
    // Shows each answer, or that the questions were skipped, in place of the menus
    const close = (answered: boolean) => {
      collector.stop();
      signal.removeEventListener("abort", skip);
      const lines = questions.map((q, i) => {
        const answer = asking.answers.get(i);
        return `**${escapeMarkdown(q.question)}**${answered && answer !== undefined ? `\n${escapeMarkdown(answer)}` : ""}`;
      });
      if (!answered) lines.push("-# Skipped.");
      return message.edit({ content: cut(lines.join("\n"), MAX_MESSAGE), components: [] });
    };
    asking.answered
      .then(() => close(true), () => close(false))
      .catch((e) => console.error("failed to close the question:", e));
    return asking;
  }

  // A typed answer, for every question not answered yet
  type(text: string) {
    this.questions.forEach((_, i) => {
      if (!this.answers.has(i)) this.answers.set(i, text);
    });
    this.check();
  }

  private check() {
    if (this.answers.size < this.questions.length) return;
    this.done.resolve(Object.fromEntries(this.questions.map((q, i) => [q.question, this.answers.get(i)!])));
  }
}
