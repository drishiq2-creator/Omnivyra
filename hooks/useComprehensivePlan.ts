/**
 * Comprehensive campaign plan TYPES (used by components/planner/ComprehensivePlanCanvas).
 * The useComprehensivePlan hook was retired 2026-11-19 with its only caller,
 * ComprehensivePlanningInterface (unreachable; it defaulted to the canned "Demo AI" provider).
 */

export interface ContentPillar {
  id: string;
  name: string;
  description: string;
  percentage: number;
  contentTypes: string[];
  platforms: string[];
  hashtagCategories: string[];
  visualStyle: {
    colors: string[];
    fonts: string[];
    templates: string[];
  };
}

export interface PlatformStrategy {
  platform: string;
  contentFrequency: {
    posts: number;
    stories: number;
    reels: number;
    videos: number;
    tweets: number;
  };
  optimalPostingTimes: {
    [key: string]: string[];
  };
  contentTypes: string[];
  characterLimits: {
    posts: number;
    stories: number;
    tweets: number;
  };
  targetMetrics: {
    impressions: number;
    engagements: number;
    followers: number;
  };
}

export interface WeeklyPlan {
  weekNumber: number;
  phase: string;
  theme: string;
  focusArea: string;
  keyMessaging: string;
  contentTypes: string[];
  platformStrategy: PlatformStrategy[];
  callToAction: string;
  targetMetrics: {
    impressions: number;
    engagements: number;
    conversions: number;
    ugcSubmissions: number;
  };
  contentGuidelines: string;
  hashtagSuggestions: string[];
  status: 'planned' | 'in_progress' | 'completed';
  completionPercentage: number;
}

export interface DailyPlan {
  id: string;
  weekNumber: number;
  dayOfWeek: string;
  date: string;
  platform: string;
  contentType: string;
  title: string;
  content: string;
  description: string;
  mediaRequirements: {
    type: string;
    dimensions: string;
    aspectRatio: string;
  };
  hashtags: string[];
  callToAction: string;
  optimalPostingTime: string;
  targetMetrics: {
    impressions: number;
    engagements: number;
    clicks: number;
  };
  status: 'planned' | 'scheduled' | 'published' | 'completed';
  priority: 'low' | 'medium' | 'high';
}

export interface CampaignStrategy {
  objective: string;
  targetAudience: string;
  keyPlatforms: string[];
  campaignPhases: {
    [key: string]: {
      name: string;
      weeks: number[];
      description: string;
    };
  };
  contentPillars: ContentPillar[];
  contentFrequency: {
    [platform: string]: {
      posts: number;
      stories: number;
      reels: number;
      videos: number;
      tweets: number;
    };
  };
  visualIdentity: {
    colors: string[];
    fonts: string[];
    templates: string[];
  };
  voiceTone: string;
  overallGoals: {
    totalImpressions: number;
    totalEngagements: number;
    followerGrowth: number;
    ugcSubmissions: number;
    playlistAdds: number;
    websiteTraffic: number;
  };
  weeklyKpis: {
    impressions: number;
    engagements: number;
    followerGrowth: number;
    ugcSubmissions: number;
  };
  hashtagStrategy: {
    branded: string[];
    industry: string[];
    trending: string[];
  };
}
