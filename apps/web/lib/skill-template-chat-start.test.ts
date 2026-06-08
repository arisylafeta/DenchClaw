import { describe, expect, it, vi } from "vitest";
import { buildSkillTemplatePrompt } from "./skill-templates";
import { startSkillTemplateChatFromDashboard } from "./skill-template-chat-start";

describe("startSkillTemplateChatFromDashboard", () => {
  it("opens a chat tab and sends the same prompt as onboarding", () => {
    const openChatTab = vi.fn(() => ({ id: "draft:template" }));
    const sendMessageInChatTab = vi.fn();

    const result = startSkillTemplateChatFromDashboard({
      templateId: "meeting-prep-brief",
      openChatTab,
      sendMessageInChatTab,
    });

    const expectedPrompt = buildSkillTemplatePrompt("meeting-prep-brief");

    expect(openChatTab).toHaveBeenCalledOnce();
    expect(sendMessageInChatTab).toHaveBeenCalledWith(
      "draft:template",
      expectedPrompt,
    );
    expect(result).toEqual({
      tabId: "draft:template",
      prompt: expectedPrompt,
    });
  });
});
