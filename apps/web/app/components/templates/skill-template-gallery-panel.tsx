"use client";

import type { SkillTemplateId } from "@/lib/skill-templates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { SkillTemplateGallery } from "./skill-template-gallery";

type SkillTemplateGalleryPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartTemplate: (templateId: SkillTemplateId) => void;
};

export function SkillTemplateGalleryPanel({
  open,
  onOpenChange,
  onStartTemplate,
}: SkillTemplateGalleryPanelProps) {
  const handleSelectTemplate = (templateId: SkillTemplateId) => {
    onStartTemplate(templateId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(780px,calc(100vh-2rem))] max-w-[min(1180px,calc(100%-2rem))] overflow-y-auto bg-[var(--color-main-bg)] p-6 sm:max-w-[min(1180px,calc(100%-2rem))]">
        <DialogTitle className="sr-only">Templates</DialogTitle>
        <DialogDescription className="sr-only">
          Browse skill templates and start a new skill-building chat.
        </DialogDescription>
        <SkillTemplateGallery
          mode="dashboard"
          onSelectTemplate={handleSelectTemplate}
          actionLabel="Start"
        />
      </DialogContent>
    </Dialog>
  );
}
