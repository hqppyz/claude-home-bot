import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
  type Message,
  type MessageEditOptions,
} from "discord.js";
import { checkAuth, Login } from "./claude";
import type { Config } from "./config";

const CODE_BUTTON = "claude-auth:code";
const CODE_MODAL = "claude-auth:modal";
const CODE_INPUT = "code";

// Discord's limit for link button URLs
const MAX_LINK_URL = 512;

// Fits both send and edit
interface Prompt {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

function prompt(login: Login): Prompt {
  const content = "Claude is not authenticated. Log in, then enter the code the page shows.";
  const code = new ButtonBuilder().setCustomId(CODE_BUTTON).setLabel("Enter code").setStyle(ButtonStyle.Primary);
  if (login.url.length > MAX_LINK_URL) {
    return { content: `${content}\n${login.url}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(code)] };
  }
  const link = new ButtonBuilder().setURL(login.url).setLabel("Log in").setStyle(ButtonStyle.Link);
  return { content, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(link, code)] };
}

const codeModal = () =>
  new ModalBuilder()
    .setCustomId(CODE_MODAL)
    .setTitle("Claude login")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Code")
        .setTextInputComponent(new TextInputBuilder().setCustomId(CODE_INPUT).setStyle(TextInputStyle.Short).setRequired(true)),
    );

// If Claude has no credentials, DMs every admin a login link and a button that
// opens a modal for the code. Resolves once an admin's code logs it in.
export async function authenticate(client: Client, config: Config): Promise<void> {
  if (await checkAuth(config)) return;
  console.error("claude is not authenticated");
  const { adminIds } = config.discord;
  if (adminIds.length === 0) {
    console.error("no admin-id configured, nobody to ask for a login");
    return;
  }

  let login = await Login.start(config);
  const messages: Message[] = [];
  for (const id of adminIds) {
    try {
      const user = await client.users.fetch(id);
      messages.push(await user.send(prompt(login)));
    } catch (e) {
      console.error(`failed to message admin ${id}:`, e);
    }
  }
  const editAll = (options: MessageEditOptions) =>
    Promise.all(messages.map((m) => m.edit(options).catch((e) => console.error("failed to edit login message:", e))));

  const { promise: done, resolve } = Promise.withResolvers<void>();

  const handle = async (interaction: Interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    if (interaction.customId !== CODE_BUTTON && interaction.customId !== CODE_MODAL) return;
    // Another instance of the bot may have sent this one, so leave it to that
    // instance. A button from a previous run goes unanswered too.
    if (!messages.some((m) => m.id === interaction.message?.id)) return;
    if (!adminIds.includes(interaction.user.id)) {
      await interaction.reply({ content: "Only admins can log Claude in.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isButton()) {
      await interaction.showModal(codeModal());
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const current = login;
    if (await current.submit(interaction.fields.getTextInputValue(CODE_INPUT))) {
      client.off(Events.InteractionCreate, onInteraction);
      console.log(`claude authenticated by ${interaction.user.tag}`);
      await editAll({ content: `Claude was authenticated by ${interaction.user.tag}.`, components: [] });
      await interaction.editReply("Authenticated.");
      resolve();
      return;
    }
    // A failed code ends the login process, so start a new one unless a
    // concurrent submit already did
    if (login === current) {
      login = await Login.start(config);
      await editAll(prompt(login));
    }
    await interaction.editReply("That code didn't work. The message has a new login link now.");
  };
  const onInteraction = (interaction: Interaction) => {
    handle(interaction).catch((e) => console.error("login interaction failed:", e));
  };
  client.on(Events.InteractionCreate, onInteraction);

  return done;
}
