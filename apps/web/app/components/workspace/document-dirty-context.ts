"use client";

import { createContext, useContext, useLayoutEffect } from "react";

/** The content-cache owner receives actual editor dirty state, not preview promotion. */
export const DocumentDirtyContext = createContext<(dirty: boolean) => void>(() => {});

export function useDocumentDirty(dirty: boolean) {
  const report = useContext(DocumentDirtyContext);
  useLayoutEffect(() => { report(dirty); }, [dirty, report]);
}
