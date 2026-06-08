import {
  buildSkillTemplatePrompt,
  type SkillTemplateId,
} from "./skill-templates";

type ChatTabTarget = {
  id: string;
};

export type StartSkillTemplateChatParams = {
  templateId: SkillTemplateId;
  openChatTab: () => ChatTabTarget;
  sendMessageInChatTab: (tabId: string, message: string) => void;
};

export function startSkillTemplateChatFromDashboard({
  templateId,
  openChatTab,
  sendMessageInChatTab,
}: StartSkillTemplateChatParams): { tabId: string; prompt: string } {
  const prompt = buildSkillTemplatePrompt(templateId);
  const tab = openChatTab();
  sendMessageInChatTab(tab.id, prompt);
  return { tabId: tab.id, prompt };
}
