# Daniel + Chris: Context Graphs, Permissioning, and Entity Value

**Date**: 2026-03-18
**Participants**: Daniel Liebeskind (CEO), Chris Psiaki (CTO)
**Duration**: ~40 minutes

## Key Ideas

### 1. Entity View as Foundation
- Click any entity → see all related topics, people, inputs
- Multi-dimensional/multi-perspective view on every entity in the organization
- "Rubik's cube" — keep rotating, see every entity and its relationships
- Topics are entities too (entity_type = 'topic')

### 2. Entity Value = Relationships
- Direct correlation between entity's relationship count and organizational value
- Weight/quality of relationships matters, not just count
- Could identify valuable employees by relationship density across customers, documents, topics
- "Shed the bottom 10%" — entities with few meaningful relationships are dead weight
- All historical data (calls, emails, docs) already exists — just needs processing

### 3. Private vs Public Context Graphs
- One **public** context graph (company-wide)
- Infinite **private** context graphs: per-person, per-relationship, per-entity
- Per-input choice: "store in my private context graph" OR "include in company context graph"
- Can review both public and private, promote private → public at any time
- Private can be scoped to a relationship (e.g., "private to both Daniel and Chris")

### 4. Every Entity Has a Context Graph
- Every entity has a dimension/perspective that pulls context
- Context sourced from private (entity-scoped) or public (organizational) graphs
- An infinite number of private context graphs + one public context graph

### 5. Federated Agents Tied to Entities
- Agents are NOT autonomous with full access (not "OpenClaw" model)
- Agents tied to specific entities (person, topic, relationship)
- Agent permissions = entity permissions
- "The point of the employee is to be the owner of the agents, and the agents are conduits that only get the information in the context that is appropriate to that employee"
- An agent can attach to an entity OR a relationship to determine accessible context graphs
- Example: "LTI agent" has access to LTI topic entity's private context
- Example: "Chris + LTI agent" has access to that relationship's context graph

### 6. MCP Must Respect Context Graph Permissions
- MCP needs awareness of which entity the user represents
- Authenticate into which entity you ARE as the MCP user
- Entity graph + relationship graph + many context graphs
- MCP must only return information the authenticated entity should access

### 7. Multi-Step Permission Pipeline (Orchestrator Pattern)
1. Check input type + submitter permissions ("does the org accept this input type?")
2. First inference pass (most powerful model): tag ALL entities in the input
3. Aggregate permissions for each entity and each unique relationship
4. Pull current context state for each entity from context graph
5. Assess how new input affects existing context
6. Sub-agents (less powerful models) update each entity's context at orchestrator's direction

### 8. Frontier vs Local Model Split for Permissions
- **Frontier models** (Claude/GPT) for orchestration: input analysis, entity tagging, permission decisions — needs to be deterministic
- **Local models** (llama3.3) for inference/context updates — probabilistic acceptable
- Critical concern: "If you don't get it right, you wind up leaking permissioned data all over the place"
- "LLMs are probabilistic, not deterministic" — requires multi-step assessment with checks at each stage

### 9. Scaling Vision
- Multiple Sparks: don't daisy-chain VRAM, load-balance independent jobs
- One server connected to all data sources (Google Workspace, Fathom, GitHub, etc.)
- Queue-based job distribution across Spark array
- "EBITDA expansion" — turn existing organizational data into value

## Transcript

[Full transcript below]

---

So the thing that excites me about what I saw, first of all, the most is the entity view, right?
The way I see it, you're going to be able to pull up any given entity and see all the topics that are related to that particular entity.
When you click me as an entity, you'll see all of the topics that I...
have either taken part in a discussion in or uploaded a document for, right?
You talk about artifacts, right?
A call is an artifact, so is a document, or I'm sorry, not artifacts, but inputs, right?
I'm calling them input artifacts, but we should just call them input.
Yeah.
Inputs is good.
Go.
Keep going.
Either way, right?
Like, I can contribute to a call.
I can contribute to a document.
I can contribute to code, you know, a PR or whatever.
Right.
But either way, all of my contributions across whatever type of input are tagged by a given topic, right?
And if you click on me as an entity, right,
You see all the topics that I touch and all the people that I touch those that I also touch and all the crossover.
The people that I touch certain topics with right when you click on a topic, you see all the people that are involved with that topic, right?
So so so basically that entity screen can be the Genesis or the or the foundation.
for effectively a multi-dimensional or multi-perspective view on every individual entity within your organization.
Yep.
So if you want to see GCA as like the top level, like topic or entity, right?
You'll then see all the topics and entities that touch GCA.
So for other topics, you'll see LTI, you'll see Canvas, you'll see recordings, you'll see calendar, scheduling, and rostering, right?
Those are the topics that are related to GCA right now, right?
And you'll see every single one of them.
And if you click on rostering, you'll see a list of entities tied to that topic.
You'll see GCA, you'll see Stride, you'll see GCDS, you'll see all the entities that have been, you'll see Chris Psyche, you'll see SAM, all the entities that are related to rostering because of all the calls, this is where the crossover between rostering and entities is.
Right?
Yeah.
So, so, so you're basically, it's, it's almost like a Rubik's cube in a way where like, you just keep rotating the fucking thing around and like, you're just looking at every entity and all the, all the things that are related to it.
Yep.
Right.
And, and, and I already, right, right.
You know, right.
How many dimensions can you add?
Exactly.
So, and, and right now, you know, the idea of topics is one of the reasons that I want to record this is the idea of topics is,
is not included in my entity graph right now, visually.
Now, I think I can construct a topic graph because I've extracted structured information.
So what I did when I went through each of these calls, good.
Topics are also entities, by the way.
No, exactly.
If everything is an entity, topic is a type of entity.
Exactly.
Right.
Exactly.
So I don't think I created a topic entity yet, but I should do that.
And so one of those columns that you saw is called relationships, you know, which I which I borrowed, which and I knew you would love it.
Another word could have been connections, but I figured we'll keep our relationships manager concept.
But anyway, so relationships, you'll see like 3,000 relationships for Daniel.
So what entities am I in relationship with?
Exactly, exactly.
And then we can start looking at trending entities, which entities are coming up more frequently, more recently.
We can have some kind of...
waiting that's based on recency.
And then, you know, so you can have those kinds of things, being able to click in.
One of the things I almost started last night, but I decided to go to bed instead, was a visualization of the entity graph, more beyond just like a table.
But I think I can actually create
something really interesting that you can sort of like 3D navigate through.
Now, I don't think that's that useful.
I just think it'll be fucking cool.
That shows the relationships, right?
Like when you ever see that LinkedIn one that was like,
LinkedIn at one point had this thing where you could basically look at your own relationship graph, essentially, and see how you're connected to everybody and how everybody's connected to each other and what does your network look like visually.
So I think you can create that kind of thing.
And whether the visualization of that is useful to us or not, it should be useful to our agentic system.
so that we have a full awareness of what's going on.
And to your point, then we work on LTI, who does that affect?
We can start understanding which entities or topics are most valuable for the organization and who is working on things that are valuable and who's not working on things that are valuable within the organization.
That's right.
And you have a direct correlation
between an entity and its number of relationships, which basically shows value, right?
Maybe, maybe.
I don't know if that's true, if merely having a high number of relationships makes an entity automatically more valuable.
I think we'll have to try to figure out
how to value each relationship or weight them in some way.
You know what I mean?
Because otherwise, you can have an entity that... For example, in our team bonding things, you guys play one of those games.
I forget what it's called.
Yeah, Gartic Phone or whatever.
Like Gartic Phone.
So Gartic Phone might actually have a lot of relationships...
I guess it wouldn't though, because it would only have relationships to, this is maybe the point, right?
It would only have relationships to our team.
So it would actually have a very few number of relationships.
Exactly.
But if you have an entity that has many relationships through all artifacts, that shows value.
But also, dude, I was also, I was talking on like individuals within the company.
I mean, even look at that entity rank, right?
It's like Topia number one, Daniel number two.
Now, bear in mind, these are all just from Fathom calls, the majority of which are me, are from me.
I know, I know.
But still, pretty interesting.
If we aggregate everything, Google Drive plus, you know, email.
Yeah, we worked on the most stuff that actually touched customers that, you know, it'd be interesting for sure.
it would immediately show value of every employee.
And I'm not talking about just showing this from a Topia perspective.
I don't think there's anybody low enough on that chain.
um where like you need to like just get rid of somebody but you know an immediate value prop to a company and an organization 100 000 employees is just like look just shed the bottom 10 percent tomorrow right right look how many relationships they have with with each other and with customers and with documents and artifacts and topics these people are in the wind
Right.
They're doing nothing.
It's dead weight.
That's actually amazing.
Yeah.
Yeah.
I mean, we long talked about it, but you're right.
This thing actually is that already.
That is what that is.
It is exactly what that is.
And the best thing about that, about what you've done here, is you're using historical calls
It's all just history that already exists at every single organization.
You just went through the calls, but all the emails have already been sent and they're all there.
All the data is already there.
All the data is there.
Exactly.
You want to make value of your data.
You want to turn your organization into something really valuable.
We talk about EBITDA expansion.
This is actually value expansion by taking all of your data and making it valuable in a safe way.
And dude, you know how you turn the four days into two days?
You just buy another Spark.
No, I know.
Well, I could also use AWS and do quasi-local, right?
Not actually local.
Like, fine.
You know, I could just get a rig in space.
Totally.
But we could... Like, you see...
The reason daisy-chaining is powerful or connecting two Sparks directly is powerful is because you turn your 124 gigabytes of VRAM into 248 gigabytes of VRAM.
That would be huge.
Well, yes, huge, sure.
But you're able to run more powerful models, which is good.
But if you already have models that run well on 124 gigabytes and provide a certain level of acceptable accuracy...
You don't need to combine the VRAM.
What you do is you have two independently running Sparks, each 124 gigabytes, and you load balance between them.
And then you can have an array of eight.
You can have an array of 50.
You can have an array of 150, 200 Spark boxes.
And then you have one server in the middle of all of them.
They're all on a local network.
You have one server.
And it's just distributing jobs to whichever Spark is open.
It has a queue, and it's just sending jobs, right?
And that one server is connected to Google Workspace, it's connected to Google Drive, it's connected to Fathom, it's connected to the organization's GitHub, it's connected to everything, and it just builds a queue of jobs
sending them all over to this whole array of sparks, and it's tagging everything by entity and building context graphs for every imaginable dimension that you want to look at anything through.
And for everything that it processes or for everything that a user requests processing for, you allow that user to choose whether this is, please do this inference and store it in my
private context graph or do this inference and include it in the company context graph.
Easy.
I think that that's a phenomenal idea, the private context graph.
It's awesome.
And you can then have a visualization where you can review both the public and your private.
And you can always just make something public.
Of course.
We could even... Hold on.
Let me think about this.
But I think...
we could say this is private, but it included me and Chris.
So it's private to both of our private context graphs.
So we could actually have not just singular, like, you know, the company-wide is basically just public, but then you can have, and then, you know, on the other side of the spectrum, we have a one-person context graph, but then we can have
multiple context graphs per relationship right exactly and you can access that context graph if you're in that relationship exactly if you exist in the relationship you have access to the context graph right which is pretty powerful i think it could get too complicated i'm not sure i don't think so i don't think so okay so now we're talking i mean when people are talking about context graph relationships themselves are entities this is just
Right.
It's all, right?
Right.
Everything is an entity.
And then every relationship has its own context graph.
And then the company- Every entity has a context graph.
Every entity has a context graph.
That's right.
Every entity has a perspective or dimension that it pulls context for.
Say that again?
Every entity has...
Every entity has a dimension or perspective that it can pull context for and every entity or dimension that you pull context for can source its context from a context graph that is private to that entity or that is public to the organization.
Right.
And private to that entity can exist across multiple, I mean, an infinite number of context graphs, basically.
Of course.
There's actually, there's basically like an infinite number of private context graphs and then one public context graph, right?
That's right.
That's right.
public domain and then everything else is a private domain.
Now, the thing that I'm not sure about yet, but that really makes this whole thing explode in value is if we can design an MCP that respects
the different context graphs per entity.
The MCP needs to be aware then that I am utilizing the MCP layer in Plot, let's say, and that I am Daniel, and then I am tied to the entity Daniel in our entity graph.
So we have an entity graph, a relationship graph, and lots of different context graphs.
So the MCP needs to have awareness of that, and you almost need to authenticate in to which entity you are as the MCP, as the owner of the agents that are using the MCP, so that it only has access to the information it should have access to.
Does that sound right to you?
I need to think on it more.
I know.
I can't say yes or no instinctively based on that.
This is what we need to figure out.
It definitely feels like the right question.
I'll say that.
Well, and then, you know, basically here's the other crazy thing is if you do it this way, then you give agents to, you know, we build these apps, you give agent capabilities and workflows to different employees and each employee's agent swarm is going to have different capabilities and access to information.
So it starts to, when you start to say what's the point of employees, it actually is that the employee is an entity
And that entity has permissions to different context graphs.
So the point of the employee is to be the owner of the agents, and the agents are conduits that only get the information in the context that is appropriate to that employee.
So they're very deeply tied together.
Whereas when some people are thinking about what agents are going to do,
There are these autonomous things that have nothing to do with the entity that can do whatever they want, that have full access to everything.
Think like OpenClaw, right?
And what we're talking about is more of like a federated agent system.
with um you know with permissioning and deep coupling to the employee except for the public context graph any agent can access that right otherwise agents are tied to an employee very specifically or we could say actually agents are tied to an entity that's kind of interesting because you could have an agent definitely tied to an entity yeah you can have an agent start up
that is tied to a topic entity like LTI to do work and review on how crucial LTI changes are right now.
And might have access to private information that only Chris and the LTI topic have access to, right?
Think about it that way.
So then an agent starts up and it has privileged information related to LTI because it's tied to the LTI entity.
And, you know, me as Daniel may not have actually all that knowledge, but this agent is tied to LTI, not tied to me.
So it can access that information.
Similarly, I could start... Or the agent starts up and is tied to a given relationship, that relationship being Chris plus LTI, Dan plus LTI, you know.
Right.
Oh, yeah, that's right.
So agents then can, I think, assuming that this is technically possible, which I have to assume it is, an agent through the MCP can attach from a permissioning standpoint, from a federated standpoint, to either an entity or a relationship or maybe both in order to determine what context graphs it's able to access.
Correct.
And it probably can then access multiple context graphs.
It has that capability and it merges them together.
Yeah, it's just pulling all the relevant context from each of those graphs
for the entity that it is representative of, and then it just merges the context.
The complication is going to be that happens when an input payload comes into the context system, it has to take into account the permissioning that's attached to that input payload in order to determine what the output tokens are going to be and what data is going to be accessed.
You know what I mean?
Exactly.
And it starts with dissecting the input, tagging it with the various entities that are involved with that input, and do I have permission to execute on behalf of this entity, this entity, this entity, and this entity?
This actually is not that dissimilar from our interactive nonce and key system.
It's not the same thing, obviously, but it's...
It's, you know, you're getting this payload that has permissioning information because we're going to need something that's actually a little bit sophisticated like that in order to... It's also potentially this is the role of the orchestration agent, right?
Where like the input comes in, it launches an orchestrator and then it launches agents on behalf of each entity in that input
and the agents for the relationships, each unique relationship between the entities in that input.
Yeah.
Right.
I think that's right.
And one of the challenges here, by the way, is going to be that the local models are inferior in their capabilities and in their general, you can't just like lob something over the fence with Lama 3.3 and expect it to deterministically get right.
Of course, of course.
So I think we need to actually try to shift
as much as we can to the orchestrator that maybe lives in the frontier around the input that's coming in and the permissions.
I don't know.
I think this dynamic of which side of the fence are we doing the processing or trying to make this more deterministic and is this how we're actually using the frontiers?
And what's the role of Lama 3.3 around this?
Because my fear here is that if you don't get it right, you wind up leaking permissioned data all over the place in the wrong ways.
And that could be pretty catastrophic.
So I don't know.
And, and, you know, by definition, LLMs are probabilistic, not deterministic.
And then you factor in something like mama 3.3, which is.
What we need to do is like multi-step, like kind of like, like assessment of what, what the system does at each step in its journey.
Right.
Like,
When an input is added at the top, what are we looking for, right?
We're looking for the type of input, document, call recording, whatever, right?
We're looking for who submitted it, okay?
So now we have an idea of like the source of this information and why that might be relevant to the information itself.
right?
Okay, so we've, you know, and then what permissions does this person and this document type have in general?
Like, does the system, does the organizational context graph even accept this input type?
Yes or no?
And, you know, we make
Does the person that submitted this input have the ability and the permission to submit these types of inputs, right?
Like we check those things on the top level.
Okay, great.
Let's say it all checks out.
Now the input moves in to an inference step.
Okay.
What level of inference are we going to do on this thing right now?
Okay.
Well, let's start with, I don't know, let's just say the most powerful internal model that we have.
Right, and the largest.
Assume we get that and we can run it in AWS.
Exactly, and we have the largest context window that we have available for that largest model, right?
So the input goes through that first and its job
It less less of a job to like interpret or let's just say in this moment, less important to interpret the meaning of the thing.
Right.
But most important, let's say, in step one to tag all of the entities that are involved in this input.
So if it's a call, find all the individuals, their names, find all the topics and what the individuals are talking about, and create a list of all the tags, right?
Or create a list of all the entities that are tagged in this input.
Great.
Once we have that, now we aggregate all of the permissions that each one of these entities have, all of the...
Context or I'm sorry all of the permissions that each unique relationship.
Between entities has right and and and and the input itself and the topics are all entities, right?
So people to topic people to people, so on and so forth.
So find all the entities, right?
and find all the permissions that each of those entities have and find all the um uh um uh the the context the the current state of context for each of those entities in the organization right and then you know once we have all those things now we start to do an assessment of like how the input that we just discovered all these entities associations with
and all of the contexts available for each of those things, not all up in a context window, but we've just pulled those things out of our context graph and out of our database.
Now we do, okay, how does this new input affect the existing context of each of these entities and these relationships and all those things?
Right, and now it's the job of sub agents, perhaps running less powerful models to do the inference on the document to then update the existing context for each entity.
Each a job that is sub agent is doing at the direction of the orchestration agent at the top.
Maybe.
Yeah, I love it.
All right.
We should talk more about it, but I got to run because I'm 10 minutes late to a meeting and the guy's only going to wait for 10.
Sorry, bro.
Bye.
No, you're good.
