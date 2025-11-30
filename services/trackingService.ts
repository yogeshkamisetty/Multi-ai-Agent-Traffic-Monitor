
import { DetectionItem } from "../types";

// Types for internal tracker state
interface TrackedObject {
  id: number;
  class: string;
  box: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  centroid: [number, number]; // [x, y] normalized
  history: [number, number][]; // History of centroids
  missingFrames: number;
  speed: number;
  dy: number; // Vertical velocity component for flow detection
  laneStatus: 'Stable' | 'Lane Change' | 'Merging';
  createdAt: number;
}

export class ObjectTracker {
  private tracks: TrackedObject[] = [];
  private nextId = 1;
  // Tuned Parameters
  private maxMissingFrames = 50; 
  private iouThreshold = 0.15; 
  
  // Violation Thresholds
  private SPEED_LIMIT = 80; // km/h (Demonstration threshold)
  private WRONG_WAY_THRESHOLD = -0.01; // Movement against flow

  constructor() {}

  // Main update method called with new detections from API
  public update(detections: DetectionItem[], timestamp: number): DetectionItem[] {
    const validDetections = detections.filter(d => d.box_2d && d.type === 'vehicle');
    
    // 1. Predict (Update existing tracks missing count)
    this.tracks.forEach(t => t.missingFrames++);

    // 2. Match (Greedy matching based on IoU/Distance)
    const unmatchedDetections = new Set(validDetections.map((_, i) => i));
    
    // Simple matching loop
    this.tracks.forEach(track => {
      let bestMatchIndex = -1;
      let bestIoU = 0;

      validDetections.forEach((det, index) => {
        if (!unmatchedDetections.has(index) || !det.box_2d) return;
        
        const iou = this.calculateIoU(track.box, det.box_2d);
        if (iou > this.iouThreshold && iou > bestIoU) {
          bestIoU = iou;
          bestMatchIndex = index;
        }
      });

      if (bestMatchIndex !== -1) {
        // MATCH FOUND
        unmatchedDetections.delete(bestMatchIndex);
        const match = validDetections[bestMatchIndex];
        
        // Update Track
        track.missingFrames = 0;
        track.box = match.box_2d!;
        const newCentroid = this.getCentroid(match.box_2d!);
        
        // Calculate Speed & Direction
        const deltaY = newCentroid[1] - track.centroid[1]; // + is Down, - is Up
        const absDeltaY = Math.abs(deltaY);
        
        track.dy = deltaY;
        
        // Scale factor: assuming frame rate and approximate scale. 
        // 1.0 vertical screen travel = 1000 units. 
        // Speed = units per frame * arbitrary constant to look like km/h
        track.speed = Math.floor(absDeltaY * 1000 * 1.5); 

        // Update History
        track.history.push(newCentroid);
        if (track.history.length > 10) track.history.shift();

        // Advanced Lane Discipline Logic
        if (track.history.length >= 2) {
            const historyDepth = Math.min(track.history.length, 4);
            const startX = track.history[track.history.length - historyDepth][0];
            const endX = newCentroid[0];
            const lateralDisplacement = Math.abs(endX - startX);
            
            // If moved > 3% of screen width laterally over recent history
            if (lateralDisplacement > 0.03) { 
                track.laneStatus = 'Lane Change';
            } else {
                track.laneStatus = 'Stable';
            }
        }

        track.centroid = newCentroid;

        // Assign ID back to detection for UI
        match.trackId = track.id;
        match.estimatedSpeed = track.speed;
        match.laneEvent = track.laneStatus;
      }
    });

    // 3. Create New Tracks
    unmatchedDetections.forEach(index => {
      const det = validDetections[index];
      if (det.box_2d) {
        const newCentroid = this.getCentroid(det.box_2d);
        const newTrack: TrackedObject = {
          id: this.nextId++,
          class: det.object,
          box: det.box_2d,
          centroid: newCentroid,
          history: [newCentroid],
          missingFrames: 0,
          speed: 0,
          dy: 0,
          laneStatus: 'Stable',
          createdAt: timestamp
        };
        this.tracks.push(newTrack);
        
        det.trackId = newTrack.id;
        det.estimatedSpeed = 0;
        det.laneEvent = 'Stable';
      }
    });

    // 4. Violation Checks (Speeding & Wrong Way)
    // First, determine dominant flow direction
    const activeMovingTracks = this.tracks.filter(t => t.missingFrames === 0 && Math.abs(t.dy) > 0.001);
    let dominantDy = 0;
    if (activeMovingTracks.length > 0) {
        const totalDy = activeMovingTracks.reduce((sum, t) => sum + t.dy, 0);
        dominantDy = totalDy / activeMovingTracks.length; // Average direction
    }

    // Apply flags to detections
    validDetections.forEach(det => {
        if (!det.trackId) return;
        const track = this.tracks.find(t => t.id === det.trackId);
        if (!track) return;

        // Speeding Check
        if (track.speed > this.SPEED_LIMIT) {
            det.isSpeeding = true;
        }

        // Wrong Way Check (Moving opposite to dominant flow)
        // Only check if we have a clear dominant flow and this object is moving significantly
        if (Math.abs(dominantDy) > 0.005 && Math.abs(track.dy) > 0.005) {
             // If signs are different (one pos, one neg), they are opposite
             if (Math.sign(dominantDy) !== Math.sign(track.dy)) {
                 det.isWrongWay = true;
             }
        }
    });

    // 5. Cleanup
    this.tracks = this.tracks.filter(t => t.missingFrames <= this.maxMissingFrames);

    return detections;
  }

  public reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  // Helpers
  private getCentroid(box: [number, number, number, number]): [number, number] {
    // box: [ymin, xmin, ymax, xmax] normalized 0-1000
    // We normalize to 0-1 for internal math
    const y = (box[0] + box[2]) / 2 / 1000;
    const x = (box[1] + box[3]) / 2 / 1000;
    return [x, y];
  }

  private calculateIoU(boxA: number[], boxB: number[]): number {
    // box: [ymin, xmin, ymax, xmax]
    const yA = Math.max(boxA[0], boxB[0]);
    const xA = Math.max(boxA[1], boxB[1]);
    const yB = Math.min(boxA[2], boxB[2]);
    const xB = Math.min(boxA[3], boxB[3]);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
    const boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);

    if (boxAArea + boxBArea - interArea === 0) return 0;
    return interArea / (boxAArea + boxBArea - interArea);
  }
  
  public getActiveTracksCount(): number {
      return this.tracks.filter(t => t.missingFrames === 0).length;
  }
}
