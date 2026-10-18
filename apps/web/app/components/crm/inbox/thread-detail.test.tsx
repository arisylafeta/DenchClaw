// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { splitQuotedText } from "./quoted-message";
import { MessageBody } from "./message-body";
import { prepareEmail } from "./sanitize-email";
import { MessageCard } from "./message-card";
import { ConversationHeader } from "./conversation-header";
import { groupThreadParticipants, participantAvatarName, type Participant } from "./participant-chips";
import type { Message } from "./types";

const at = "2026-10-15T10:05:00Z";
function message(overrides: Partial<Message> = {}): Message {
  return { id:"message",subject:"Pack sale",sent_at:at,preview:"Older preview",body:"Unique message body",has_attachments:false,gmail_message_id:null,sender_type:null,from_person_id:null,from_name:"Morgan Lee",from_email:"morgan@example.test",to_person_ids:[],cc_person_ids:[],...overrides };
}

describe("quoted message folding", () => {
  it.each([
    "On Thu, 15 Oct 2026 at 10:05, Alex <alex@rebattery.io> wrote:\n> Earlier message",
    "On Thu, 15 Oct 2026 at 10:05, Alex\n<alex@rebattery.io> wrote:\nEarlier message",
    "> Earlier message\n> Another quoted line",
    "-- \nAlex Polglase\nFounder & CEO\nalex@rebattery.io",
    "From: Alex <alex@rebattery.io>\nSent: Thursday, 15 October 2026\nTo: Morgan\nSubject: Pack sale\nEarlier message",
    "Best,\nAlex Polglase\nFounder & CEO\nalex@rebattery.io",
    "Alex Polglase\nFOUNDER & CEO\nrebattery.io • alex@rebattery.io",
  ])("folds conventional history or footer: %s", (tail) => {
    expect(splitQuotedText(`Hello Morgan,\n\nPlease confirm collection.\n\n${tail}`)).toEqual({visible:"Hello Morgan,\n\nPlease confirm collection.",hidden:tail.trim()});
  });
  it("does not fold ordinary text or a lone From field", () => {
    const text="Hello Morgan,\n\nFrom: our collection point\nPlease send the address.\n\nThanks,\nAlex";
    expect(splitQuotedText(text)).toEqual({visible:text,hidden:""});
  });
  it("reduces runs of blank lines without changing message content", () => {
    expect(splitQuotedText("Hello\n\n\n\nWorld")).toEqual({visible:"Hello\n\nWorld",hidden:""});
  });
  it("reveals and re-collapses the exact quoted text on demand", () => {
    render(<MessageBody body={"Current reply\n\nOn Thursday, Alex wrote:\n> Earlier message"} preview={null} />);
    expect(screen.getByText("Current reply")).toBeInTheDocument();
    expect(screen.queryByText(/Earlier message/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Show quoted text"}));
    expect(screen.getByText(/Earlier message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Hide quoted text"}));
    expect(screen.queryByText(/Earlier message/)).not.toBeInTheDocument();
  });
  it("hides sanitized Gmail quotes until requested", () => {
    const html='<p onclick="alert(1)">Current reply</p><div class="gmail_quote"><blockquote>Earlier message</blockquote></div><div class="gmail_signature">Footer</div><script>alert(1)</script>';
    render(<MessageBody body="Text alternative" html={html} preview={null} />);
    const frame=screen.getByTitle("Email body");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).not.toContain("Earlier message");
    expect(frame.getAttribute("srcdoc")).not.toContain("onclick=");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
    fireEvent.click(screen.getByRole("button",{name:"Show quoted text"}));
    expect(frame.getAttribute("srcdoc")).toContain("Earlier message");
  });
  it("preserves email typography after reader defaults", () => {
    const doc=prepareEmail('<html><head><style>p{font-family:serif;font-size:30px}</style></head><body><p>Hello</p></body></html>').srcdoc;
    expect(doc.indexOf("font-size:30px")).toBeGreaterThan(doc.indexOf("font:14px"));
    expect(doc).not.toContain("<script");
  });
});

describe("compact thread header", () => {
  const participants:Participant[]=[
    {id:"ari",name:"Ari Sylafeta",email:"ari@rebattery.io",avatar_url:null,is_self:true},
    {id:"alex",name:"Harry Ferson",email:"alex@rebattery.io",avatar_url:null,is_self:true},
    {id:"morgan",name:"Morgan Lee",email:"morgan@example.test",avatar_url:null,is_self:false},
    {id:"duplicate",name:"Morgan Lee",email:"MORGAN@example.test",avatar_url:null,is_self:false},
  ];
  it("deduplicates self addresses once and uses actual names/emails for avatars", () => {
    const groups=groupThreadParticipants(participants);
    expect(groups.map((group)=>group.label)).toEqual(["Morgan Lee","You"]);
    expect(groups[1].emails).toEqual(["ari@rebattery.io","alex@rebattery.io"]);
    expect(participantAvatarName(participants[0])).toBe("ari");
    expect(participantAvatarName(participants[1])).toBe("alex");
    expect(participantAvatarName(participants[2])).toBe("Morgan Lee");
  });
  it("has one participant line, thread dates/count, working profile and header actions", () => {
    const onOpenPerson=vi.fn(),onToggleStar=vi.fn(),onClose=vi.fn();
    render(<ConversationHeader subject="Pack sale" participants={participants} gmailThreadId={null} threadId="thread" starred={false} onToggleStar={onToggleStar} onOpenPerson={onOpenPerson} onClose={onClose} messageCount={4} firstMessageAt={at} lastMessageAt={at} />);
    expect(screen.getAllByLabelText("Thread participants")).toHaveLength(1);
    expect(screen.queryByText("Harry Ferson")).not.toBeInTheDocument();
    expect(screen.queryByText(/To:/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Thread metadata")).toHaveTextContent("4 messages");
    expect(screen.getByLabelText("Thread metadata")).toHaveTextContent("First:");
    expect(screen.getByLabelText("Thread metadata")).toHaveTextContent("Last:");
    fireEvent.click(screen.getByRole("button",{name:"CRM profile ↗"}));
    expect(onOpenPerson).toHaveBeenCalledWith("morgan");
    fireEvent.click(screen.getByTitle("Star"));expect(onToggleStar).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTitle("Back to inbox"));expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText("Show participant emails"));
    expect(screen.getByText("ari@rebattery.io, alex@rebattery.io")).toBeVisible();
  });
});

describe("flat message disclosures", () => {
  it("keeps an older message collapsed to a summary and expands it on click", () => {
    render(<MessageCard message={message()} people={new Map()} defaultExpanded={false} />);
    const summary=screen.getByRole("button",{expanded:false});
    expect(summary).toHaveTextContent("Morgan Lee");expect(summary).toHaveTextContent("Older preview");
    expect(screen.queryByText("Unique message body")).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded","true");
    expect(screen.getByText("Unique message body")).toBeInTheDocument();
    fireEvent.click(summary);expect(screen.queryByText("Unique message body")).not.toBeInTheDocument();
  });
  it("expands the newest message and keeps observed outbound tracking as muted chips", () => {
    render(<MessageCard message={message({direction:"outbound",is_self:true,delivered_at:at,opened_at:at,clicked_at:at,replied_at:at})} people={new Map()} defaultExpanded />);
    expect(screen.getByRole("button",{expanded:true})).toHaveTextContent("You");
    expect(screen.getByText("Unique message body")).toBeInTheDocument();
    const tracking=screen.getByLabelText("Delivery tracking");
    for(const label of ["Delivered","Opened","Clicked","Replied"]){expect(within(tracking).getByText(label)).toBeInTheDocument();}
  });
});
