import * as google from 'googleapis';
import { resolve } from 'path';
import * as AzSB from '@azure/storage-blob';
import cbfs from 'fs';
import { promisify } from 'util';
const fs = {
	stat: promisify(cbfs.stat),
	read: promisify(cbfs.readFile),
	write: promisify(cbfs.writeFile)
};

const API_KEY = process.env['API_KEY'];

// list of youtube channels, sorted from high to low priority
const SourceYoutubeChannels = [
	// 'UC-r31xs58uQtLrpXDNazBpw', // stevenvergenz
	'UCtI0Hodo5o5dUb67FeUjDeA', // SpaceX
	'UCVxTHEKKLxNjGcvVaZindlg', // Blue Origin
	// 'UCRn9F2D9j-t4A-HgudM7aLQ', // Arianespace
	'UCsWq7LZaizhIi-c-Yo_bcpw', // Rocket Lab
	'UC6uKrU_WqJ1R2HMTY3LIx5Q', // Everyday Astronaut
	// 'UCnrGPRKAg1PgvuSHrRIl3jg', // ULA
	'UCSUu1lih2RifWkKtDOJdsBA', // NASASpaceflight
	'UCLA_DiR1FfKNvjuUpBHmylQ', // NASA TV
];

const VidPriorities = new Map<RegExp, number>();
VidPriorities.set(/Mission Control Audio/, -1);
VidPriorities.set(/^NASA Live: Official Stream of NASA TV$/, 1);

export interface VideoDetails {
	index: number;
	id: string;
	url: string;
	name: string;
	thumbnailUrl: string;
	thumbnailRatio: number;
	live: boolean;
	startTime: number;
	priority?: number;
	manuallyAdded: boolean;
}

const CACHEPATH = process.env['CACHE_PATH'] || resolve(__dirname, '../db/cache.json');
const EXPIRY = 6 * 60 * 60 * 1000; // 8 hours in ms

export class ChannelManager {
	public videoDetails: VideoDetails[];

	public get liveVideos() {
		return this.videoDetails.filter(vd => vd.live);
	}

	public get highestPriorityStream() {
		return this.videoDetails.find(vd => vd.live);
	}

	public async refreshLiveStatus() {
		if (this.videoDetails.length === 0) return;
		const nowPlaying: string[] = [];
		
		try {
			const service = new google.youtube_v3.Youtube({ auth: API_KEY });
			const response = await service.videos.list({
				part: ['snippet', 'liveStreamingDetails'],
				id: this.videoDetails.filter(vd => /^youtube:/.test(vd.url)).map(vd => vd.id),
				maxResults: this.videoDetails.length,
				key: API_KEY
			});

			const updates: { [id: string]: Partial<VideoDetails> } = {};
			for (const result of response.data.items) {
				updates[result.id] = {
					name: result.snippet.title,
					live: result.snippet.liveBroadcastContent === 'live',
					startTime: result.liveStreamingDetails ?
						Date.parse(result.liveStreamingDetails.actualStartTime
							|| result.liveStreamingDetails.scheduledStartTime) :
						null
				};
			}

			for (const vid of this.videoDetails) {
				if (vid.live === false && updates[vid.id].live === true) {
					nowPlaying.push(vid.id);
				}
				Object.assign(vid, updates[vid.id]);
			}
		} catch (err) {
			console.error(err);
		}

		return nowPlaying;
	}

	public async updateVideoLinks(force = false) {
		if (!force) {
			this.videoDetails = await ChannelManager.getDataFromCache();
			if (this.videoDetails) {
				// fresh cache data found, use it
				this.videoDetails = [...this.videoDetails, ...ChannelManager.getManualData()];
				await this.refreshLiveStatus();
				console.log("Videos found:", this.videoDetails.map(vd => vd.name));
				return;
			}
		}

		this.videoDetails = [...(await ChannelManager.getDataFromWeb()), ...ChannelManager.getManualData()];
		await this.refreshLiveStatus();
		await ChannelManager.saveDataToCache(this.videoDetails.filter(vd => !vd.manuallyAdded));
		console.log("Videos found:", this.videoDetails.map(vd => vd.name));
	}

	private static async getDataFromCache(): Promise<VideoDetails[]> {
		let stringData: string;
		try {
			if (process.env.ASB_CONNSTRING && process.env.ASB_CONTAINER) {
				console.log("Pulling data from Azure cache");
				const serviceClient = AzSB.BlobServiceClient.fromConnectionString(process.env.ASB_CONNSTRING);
				const containerClient = serviceClient.getContainerClient(process.env.ASB_CONTAINER);
				const blobClient = containerClient.getBlobClient("cache.json");
				const metadata = await blobClient.getProperties();
				const expiry = (metadata.lastModified.getTime() + EXPIRY) - Date.now();
				if (expiry < 0) {
					console.log('Azure cache is stale, refreshing');
					return null;
				} else {
					const prettyExpiry = Math.ceil(expiry / 60_000).toLocaleString("en-US");
					console.log(`Azure cache is fresh, expires in ${prettyExpiry} minutes`);
				}

				stringData = (await blobClient.downloadToBuffer()).toString('utf8');
			} else {
				console.log("Pulling data from file cache");
				const metadata = await fs.stat(CACHEPATH);
				if (metadata.mtimeMs < (Date.now() - EXPIRY)) {
					console.log('File cache is stale, refreshing');
					return null;
				}

				stringData = await fs.read(CACHEPATH, { encoding: 'utf8' });
			}
		} catch (e) {
			// failed to fetch cache metadata
			const ex = e as NodeJS.ErrnoException;
			if (ex.code === 'ENOENT') {
				console.log('No cache data found, fetching from web');
			} else {
				console.error('Failed to read from cache:', ex);
			}
			return null;
		}

		return JSON.parse(stringData) as VideoDetails[];
	}

	private static async saveDataToCache(videos: VideoDetails[]) {
		try {
			if (process.env.ASB_CONNSTRING && process.env.ASB_CONTAINER) {
				const serviceClient = AzSB.BlobServiceClient.fromConnectionString(process.env.ASB_CONNSTRING);
				const containerClient = serviceClient.getContainerClient(process.env.ASB_CONTAINER);
				const blob = new Buffer(JSON.stringify(videos), 'utf8');
				await containerClient.uploadBlockBlob("cache.json", blob, blob.byteLength);
			} else {
				await fs.write(
					CACHEPATH,
					JSON.stringify(videos),
					{ encoding: 'utf8' }
				);
			}
		}
		catch (e) {
			console.error('Failed to write to cache:', e);
		}
	}

	private static async getDataFromWeb(): Promise<VideoDetails[]> {
		const videoDetails: VideoDetails[] = [];

		const service = new google.youtube_v3.Youtube({ auth: API_KEY });
		for (const channelId of SourceYoutubeChannels) {
			const streams: google.youtube_v3.Schema$SearchResult[] = [];
			try {
				const liveStreams = await service.search.list({
					part: ['snippet'],
					channelId,
					type: ['video'],
					eventType: 'live',
					order: 'rating',
					relevanceLanguage: 'en',
					maxResults: 5,
					key: API_KEY
				});
				streams.push(...liveStreams.data.items);
				const upcomingStreams = await service.search.list({
					part: ['snippet'],
					channelId,
					type: ['video'],
					eventType: 'upcoming',
					order: 'rating',
					relevanceLanguage: 'en',
					maxResults: 5,
					key: API_KEY
				});
				streams.push(...upcomingStreams.data.items);
			} catch (e) {
				console.error(e);
			}

			videoDetails.push(
				...streams.map(result => {
					const deets = {
						id: result.id.videoId,
						name: result.snippet.title,
						url: `youtube://${result.id.videoId}`,
						thumbnailUrl: result.snippet.thumbnails.default.url,
						live: result.snippet.liveBroadcastContent === 'live',
						priority: 0,
						manuallyAdded: false
					} as VideoDetails;

					for (const [regex, pri] of VidPriorities.entries()) {
						if (regex.test(deets.name)) {
							deets.priority = pri;
						}
					}

					return deets;
				})
				.sort((a, b) =>
					((b.priority || 0) - (a.priority || 0))
					|| a.name.localeCompare(b.name, "en-US", { sensitivity: 'base' })
				)
			);
		}
		videoDetails.forEach((vid, i) => vid.index = i);
		return videoDetails;
	}

	private static getManualData() {
		// use manually provided video IDs instead of searching if provided
		if (process.env.VIDEO_URLS) {
			const urls = process.env.VIDEO_URLS.split(';');
			return urls.map((url, i) => {
				return {
					index: i,
					id: url.startsWith("youtube://") ? url.slice(10) : url,
					name: `Manual Video ${i}`,
					url,
					live: true,
					manuallyAdded: true
				} as VideoDetails;
			});
		} else {
			return [];
		}
	}
}
