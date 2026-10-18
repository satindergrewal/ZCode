import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import { isTaskNotificationSoundEnabled } from "@/lib/taskNotificationPreferences.js";

let taskNotificationAudio: HTMLAudioElement | null = null;

function getTaskNotificationAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!taskNotificationAudio) {
    taskNotificationAudio = new Audio(taskNotificationPopUrl);
    taskNotificationAudio.preload = "auto";
  }

  return taskNotificationAudio;
}

export async function playTaskNotificationSound(): Promise<void> {
  // Desktop/Web both trigger sound asynchronously after "notification shown"; without the
  // sub-switch check here, muting in settings would keep runtime beeping, looking like a no-op.
  // Centralizing the final decision in the player entry keeps every caller consistent.
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }

  const audio = getTaskNotificationAudio();
  if (!audio) {
    return;
  }

  try {
    // A reused Audio instance that is not rewound to the start often plays the next notification
    // silently, still parked at the previous ended state. Reset the play position explicitly and
    // swallow autoplay-policy errors so a sound failure never disturbs the notification path.
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // Sound is an enhancement; a failed playback never breaks the notification flow.
  }
}
