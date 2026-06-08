"use client";

import { useState } from "react";
import {
  SKILL_TEMPLATES,
  type SkillTemplateId,
} from "@/lib/skill-templates";
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
  const [selectedTemplateId, setSelectedTemplateId] = useState<SkillTemplateId>(
    SKILL_TEMPLATES[0].id,
  );

  const handleSelectTemplate = (templateId: SkillTemplateId) => {
    setSelectedTemplateId(templateId);
    onStartTemplate(templateId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(780px,calc(100vh-2rem))] max-w-[min(1180px,calc(100%-2rem))] overflow-y-auto p-6 sm:max-w-[min(1180px,calc(100%-2rem))]">
        <DialogTitle className="sr-only">Templates</DialogTitle>
        <DialogDescription className="sr-only">
          Browse skill templates and start a new skill-building chat.
        </DialogDescription>
        <SkillTemplateGallery
          mode="dashboard"
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={handleSelectTemplate}
          actionLabel="Start"
        />
      </DialogContent>
    </Dialog>
  );
}
